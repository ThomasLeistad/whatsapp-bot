// src/bot/whatsapp.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { procesarComprobante } = require('../ocr/processor');
const { buscarMatch, aprenderMatch } = require('../matching/matcher');
const { query } = require('../db/connection');

const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP_NUMBER; // ej: 5491112345678@c.us
const COMPROBANTES_DIR = process.env.COMPROBANTES_DIR || './comprobantes';

// Estado en memoria de sesiones de confirmación activas
// Key: adminWhatsapp, Value: { comprobante_id, candidatos, esperandoRespuesta }
const sesionesActivas = new Map();

// Referencia al socket.io para notificar al dashboard
let io = null;
function setIO(socketio) { io = socketio; }

// ──────────────────────────────────────────
//  Inicializar cliente WhatsApp
// ──────────────────────────────────────────
function crearCliente() {
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: process.env.SESSIONS_DIR || './sessions'
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  // ── Eventos del cliente ──
  client.on('qr', (qr) => {
    logger.info('QR generado — escaneá con el teléfono de la empresa:');
    qrcode.generate(qr, { small: true });
    if (io) io.emit('qr', qr);
  });

  client.on('ready', () => {
    logger.info('✅ WhatsApp conectado y listo!');
    if (io) io.emit('status', { conectado: true, mensaje: 'WhatsApp conectado' });
  });

  client.on('authenticated', () => {
    logger.info('✅ WhatsApp autenticado');
  });

  client.on('auth_failure', (msg) => {
    logger.error('❌ Error de autenticación WhatsApp:', msg);
    if (io) io.emit('status', { conectado: false, mensaje: 'Error de autenticación' });
  });

  client.on('disconnected', (reason) => {
    logger.warn('WhatsApp desconectado:', reason);
    if (io) io.emit('status', { conectado: false, mensaje: `Desconectado: ${reason}` });
  });

  // ── Manejo de mensajes entrantes ──
  client.on('message', async (msg) => {
    try {
      await procesarMensaje(client, msg);
    } catch (err) {
      logger.error('Error procesando mensaje:', err);
    }
  });

  return client;
}

// ──────────────────────────────────────────
//  Router principal de mensajes
// ──────────────────────────────────────────
async function procesarMensaje(client, msg) {
  const from = msg.from;
  const body = msg.body?.trim().toLowerCase() || '';

  logger.info(`Mensaje recibido de ${from}: tipo=${msg.type} body="${body.substring(0, 50)}"`);

  // 1. Si es el ADMIN respondiendo una confirmación pendiente
  if (from === ADMIN_NUMBER && sesionesActivas.has(from)) {
    await manejarRespuestaAdmin(client, msg, from, body);
    return;
  }

  // 2. Si tiene imagen o documento = comprobante de pago
  if (msg.hasMedia && ['image', 'document'].includes(msg.type)) {
    await manejarComprobante(client, msg, from);
    return;
  }

  // 3. Comandos del admin
  if (from === ADMIN_NUMBER) {
    await manejarComandoAdmin(client, msg, body);
    return;
  }

  // 4. Si alguien manda texto sin media
  if (msg.type === 'chat') {
    await client.sendMessage(from,
      '👋 Hola! Para procesar tu pago, por favor enviá una *imagen o PDF* del comprobante de transferencia o Mercado Pago.'
    );
  }
}

// ──────────────────────────────────────────
//  Procesar comprobante recibido
// ──────────────────────────────────────────
async function manejarComprobante(client, msg, from) {
  await client.sendMessage(from, '🔄 Recibí tu comprobante, estoy procesándolo... Un momento por favor.');

  // Descargar archivo
  const media = await msg.downloadMedia();
  if (!media) {
    await client.sendMessage(from, '❌ No pude descargar el archivo. Por favor reenvialo.');
    return;
  }

  const extension = media.mimetype.includes('pdf') ? 'pdf' : 'jpg';
  const timestamp = Date.now();
  const filename = `comp_${from.replace('@c.us', '')}_${timestamp}.${extension}`;
  const filepath = path.join(COMPROBANTES_DIR, filename);

  // Guardar en disco
  fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));
  logger.info(`Comprobante guardado: ${filepath}`);

  // Verificar duplicado por hash
  const { calcularHash } = require('../ocr/processor');
  const hash = calcularHash(filepath);
  const duplicado = await query('SELECT id FROM comprobantes_pago WHERE hash_comprobante = ?', [hash]);
  if (duplicado.length > 0) {
    await client.sendMessage(from, '⚠️ Este comprobante ya fue procesado anteriormente.');
    fs.unlinkSync(filepath);
    return;
  }

  // Guardar registro inicial en DB
  const [result] = await query(
    `INSERT INTO comprobantes_pago 
     (whatsapp_from, archivo_nombre, archivo_path, tipo_archivo, hash_comprobante, estado)
     VALUES (?, ?, ?, ?, ?, 'pendiente')`,
    [from, filename, filepath, extension === 'pdf' ? 'pdf' : 'imagen', hash]
  );
  const comprobanteId = result.insertId;

  // OCR
  let datosOCR;
  try {
    datosOCR = await procesarComprobante(filepath);
  } catch (err) {
    logger.error('Error OCR:', err);
    await query("UPDATE comprobantes_pago SET estado='error_ocr' WHERE id=?", [comprobanteId]);
    await client.sendMessage(from, '❌ No pude leer el comprobante. ¿Podés enviar una foto más nítida?');
    return;
  }

  // Actualizar DB con datos OCR
  await query(
    `UPDATE comprobantes_pago SET
     ocr_texto_raw=?, monto_extraido=?, nombre_extraido=?,
     alias_extraido=?, cbu_extraido=?, nro_transaccion=?
     WHERE id=?`,
    [
      datosOCR.textoRaw?.substring(0, 5000),
      datosOCR.monto,
      datosOCR.nombre,
      datosOCR.alias,
      datosOCR.cbu,
      datosOCR.nroTransaccion,
      comprobanteId
    ]
  );

  // Matching
  const resultadoMatch = await buscarMatch(datosOCR);

  if (io) io.emit('nuevo_comprobante', { id: comprobanteId, from, datos: datosOCR });

  if (resultadoMatch.automatico && resultadoMatch.candidatos.length > 0) {
    // ── Match automático (socio conocido) ──
    const candidato = resultadoMatch.candidatos[0];
    await confirmarPagoAutomatico(client, from, comprobanteId, candidato, datosOCR);
  } else if (resultadoMatch.candidatos.length > 0) {
    // ── Necesita confirmación manual del admin ──
    await solicitarConfirmacionAdmin(client, from, comprobanteId, resultadoMatch.candidatos, datosOCR);
  } else {
    // ── Sin match ──
    await query("UPDATE comprobantes_pago SET estado='error_ocr', match_tipo='fallido' WHERE id=?", [comprobanteId]);
    await client.sendMessage(from,
      `⚠️ Recibí tu comprobante pero no encontré ningún pedido pendiente asociado.\n\n` +
      `*Datos leídos:*\n` +
      `• Monto: ${datosOCR.monto ? `$${datosOCR.monto.toLocaleString('es-AR')}` : 'No detectado'}\n` +
      `• Nombre: ${datosOCR.nombre || 'No detectado'}\n\n` +
      `Voy a avisar al equipo para que lo revisen manualmente. 🙏`
    );

    // Notificar al admin de todos modos
    await client.sendMessage(ADMIN_NUMBER,
      `🔔 *Comprobante sin match*\n` +
      `De: ${from}\n` +
      `Monto: ${datosOCR.monto ? `$${datosOCR.monto}` : 'N/D'}\n` +
      `Nombre en comprobante: ${datosOCR.nombre || 'N/D'}\n` +
      `Alias: ${datosOCR.alias || 'N/D'}\n` +
      `Archivo: ${filename}\n\n` +
      `Ver en dashboard: /comprobantes/${comprobanteId}`
    );
  }
}

// ──────────────────────────────────────────
//  Confirmar pago automático
// ──────────────────────────────────────────
async function confirmarPagoAutomatico(client, from, comprobanteId, candidato, datosOCR) {
  const pedido = candidato.pedido;
  const nombreCompleto = `${pedido.nombre || ''} ${pedido.apellido || ''}`.trim();

  // Actualizar comprobante
  await query(
    `UPDATE comprobantes_pago SET 
     estado='confirmado', match_tipo='automatico',
     pedido_id_match=?, match_score=?, fecha_confirmacion=NOW()
     WHERE id=?`,
    [pedido.id || pedido.pedido_id, candidato.score, comprobanteId]
  );

  // Marcar pago en datospedidos
  await query(
    `UPDATE datospedidos SET pagado=1, fechaPago=NOW(), comprobante=?, procesado=1
     WHERE id=?`,
    [comprobanteId.toString(), pedido.id || pedido.pedido_id]
  );

  // Aprender el match para la próxima vez
  await aprenderMatch(pedido.id || pedido.pedido_id, datosOCR);

  await client.sendMessage(from,
    `✅ *¡Pago acreditado automáticamente!*\n\n` +
    `• Socio: *${nombreCompleto}*\n` +
    `• Monto: *$${datosOCR.monto?.toLocaleString('es-AR') || 'N/D'}*\n` +
    `• Pedido #${pedido.pedidoID || pedido.id}\n\n` +
    `Gracias por tu pago! 🙌`
  );

  logger.info(`✅ Pago automático acreditado: pedido ${pedido.id}, monto ${datosOCR.monto}`);
  if (io) io.emit('pago_confirmado', { comprobanteId, pedidoId: pedido.id, tipo: 'automatico' });
}

// ──────────────────────────────────────────
//  Solicitar confirmación manual al admin
// ──────────────────────────────────────────
async function solicitarConfirmacionAdmin(client, from, comprobanteId, candidatos, datosOCR) {
  await query("UPDATE comprobantes_pago SET estado='esperando_confirmacion' WHERE id=?", [comprobanteId]);

  // Confirmar al remitente que está en proceso
  await client.sendMessage(from,
    `⏳ Recibí tu comprobante. Estoy verificando los datos con el equipo, te avisamos en breve!`
  );

  // Armar mensaje para el admin
  let mensaje = `🔔 *Nuevo comprobante de pago requiere confirmación*\n`;
  mensaje += `━━━━━━━━━━━━━━━━━━━━\n`;
  mensaje += `📱 De: ${from.replace('@c.us', '')}\n`;
  mensaje += `💰 Monto: ${datosOCR.monto ? `*$${datosOCR.monto.toLocaleString('es-AR')}*` : '❓ No detectado'}\n`;
  mensaje += `👤 Nombre en comprobante: *${datosOCR.nombre || 'No detectado'}*\n`;
  if (datosOCR.alias) mensaje += `🏷️ Alias: ${datosOCR.alias}\n`;
  if (datosOCR.nroTransaccion) mensaje += `🔢 N° Transacción: ${datosOCR.nroTransaccion}\n`;
  mensaje += `━━━━━━━━━━━━━━━━━━━━\n`;
  mensaje += `*¿A cuál de estos pedidos corresponde?*\n\n`;

  const opcionesCandidatos = {};
  candidatos.forEach((c, i) => {
    const p = c.pedido;
    const nombre = `${p.nombre || ''} ${p.apellido || ''}`.trim();
    const num = i + 1;
    opcionesCandidatos[num] = { pedido: p, score: c.score };
    mensaje += `*${num}.* ${nombre}\n`;
    mensaje += `    📧 ${p.email || 'sin email'}\n`;
    mensaje += `    🎫 Pedido #${p.pedidoID || p.id}\n`;
    mensaje += `    📊 Similitud: ${Math.round(c.score * 100)}%\n\n`;
  });

  mensaje += `*0.* ❌ Ninguno de los anteriores\n\n`;
  mensaje += `_Respondé con el número correspondiente (0-${candidatos.length})_`;

  // Guardar sesión activa
  sesionesActivas.set(ADMIN_NUMBER, {
    comprobante_id: comprobanteId,
    from_cliente: from,
    candidatos: opcionesCandidatos,
    datos_ocr: datosOCR,
    timestamp: Date.now()
  });

  // Guardar en DB también
  await query(
    `INSERT INTO sesiones_confirmacion (comprobante_id, admin_whatsapp, estado, opciones_json, expira)
     VALUES (?, ?, 'esperando', ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
    [comprobanteId, ADMIN_NUMBER, JSON.stringify(opcionesCandidatos)]
  );

  await client.sendMessage(ADMIN_NUMBER, mensaje);
  logger.info(`Solicitud de confirmación enviada al admin para comprobante ${comprobanteId}`);
}

// ──────────────────────────────────────────
//  Manejar respuesta del admin
// ──────────────────────────────────────────
async function manejarRespuestaAdmin(client, msg, from, body) {
  const sesion = sesionesActivas.get(from);
  if (!sesion) return;

  const { comprobante_id, from_cliente, candidatos, datos_ocr } = sesion;
  const respuesta = parseInt(body.trim());

  if (isNaN(respuesta) || respuesta < 0 || respuesta > Object.keys(candidatos).length) {
    await client.sendMessage(from, `❓ No entendí. Por favor respondé con un número entre 0 y ${Object.keys(candidatos).length}`);
    return;
  }

  sesionesActivas.delete(from);

  await query(
    `UPDATE sesiones_confirmacion SET estado='respondido', respuesta=? WHERE comprobante_id=?`,
    [respuesta.toString(), comprobante_id]
  );

  if (respuesta === 0) {
    // Admin dijo que ninguno corresponde
    await query(
      `UPDATE comprobantes_pago SET estado='rechazado', match_tipo='fallido', confirmado_por=? WHERE id=?`,
      [from, comprobante_id]
    );
    await client.sendMessage(from, `✅ Entendido. Comprobante #${comprobante_id} marcado como sin coincidencia.`);
    await client.sendMessage(from_cliente,
      `❌ Lamentablemente no pudimos validar tu comprobante automáticamente. ` +
      `Un representante se va a comunicar con vos a la brevedad. 🙏`
    );
    return;
  }

  // Admin eligió un candidato
  const elegido = candidatos[respuesta];
  if (!elegido) {
    await client.sendMessage(from, `❌ Opción inválida.`);
    return;
  }

  const pedido = elegido.pedido;
  const nombreCompleto = `${pedido.nombre || ''} ${pedido.apellido || ''}`.trim();

  // Actualizar comprobante
  await query(
    `UPDATE comprobantes_pago SET
     estado='confirmado', match_tipo='manual',
     pedido_id_match=?, match_score=?,
     confirmado_por=?, fecha_confirmacion=NOW()
     WHERE id=?`,
    [pedido.id, elegido.score, from, comprobante_id]
  );

  // Marcar pago en datospedidos
  await query(
    `UPDATE datospedidos SET pagado=1, fechaPago=NOW(), comprobante=?, procesado=1, fechaAcre=NOW()
     WHERE id=?`,
    [comprobante_id.toString(), pedido.id]
  );

  // Aprender el match para automatización futura
  await aprenderMatch(pedido.id, datos_ocr);

  await client.sendMessage(from,
    `✅ Perfecto! Pago confirmado y acreditado:\n` +
    `• Socio: *${nombreCompleto}*\n` +
    `• Pedido #${pedido.pedidoID || pedido.id}\n` +
    `• Monto: *$${datos_ocr.monto?.toLocaleString('es-AR') || 'N/D'}*\n\n` +
    `🧠 _Guardé la asociación para reconocerlo automáticamente la próxima vez._`
  );

  // Notificar al cliente
  await client.sendMessage(from_cliente,
    `✅ *¡Tu pago fue confirmado y acreditado!*\n\n` +
    `• Monto: *$${datos_ocr.monto?.toLocaleString('es-AR') || 'N/D'}*\n` +
    `• Pedido: #${pedido.pedidoID || pedido.id}\n\n` +
    `Muchas gracias! 🙌`
  );

  logger.info(`✅ Pago manual confirmado por admin: pedido ${pedido.id}`);
  if (io) io.emit('pago_confirmado', { comprobante_id, pedidoId: pedido.id, tipo: 'manual' });
}

// ──────────────────────────────────────────
//  Comandos de administración vía WhatsApp
// ──────────────────────────────────────────
async function manejarComandoAdmin(client, msg, body) {
  if (body === '/estado') {
    const stats = await query(`
      SELECT 
        SUM(estado='pendiente') as pendientes,
        SUM(estado='confirmado') as confirmados,
        SUM(estado='rechazado') as rechazados,
        SUM(estado='esperando_confirmacion') as esperando,
        COUNT(*) as total
      FROM comprobantes_pago WHERE DATE(creado) = CURDATE()
    `);
    const s = stats[0];
    await client.sendMessage(msg.from,
      `📊 *Estado de hoy:*\n` +
      `✅ Confirmados: ${s.confirmados}\n` +
      `⏳ Esperando: ${s.esperando}\n` +
      `❌ Rechazados: ${s.rechazados}\n` +
      `📋 Total: ${s.total}`
    );
  } else if (body === '/ayuda') {
    await client.sendMessage(msg.from,
      `🤖 *Comandos disponibles:*\n` +
      `/estado - Estadísticas del día\n` +
      `/ayuda - Esta ayuda`
    );
  }
}

module.exports = { crearCliente, setIO };
