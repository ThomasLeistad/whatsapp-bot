// src/matching/matcher.js
const Fuse = require('fuse.js');
const { query } = require('../db/connection');
const logger = require('../utils/logger');

const THRESHOLD = parseFloat(process.env.FUZZY_THRESHOLD) || 0.8;

// ──────────────────────────────────────────
//  1. Buscar en socios_alias (match rápido y automático)
// ──────────────────────────────────────────
async function buscarEnSocios(datosComprobante) {
  const { nombre, alias, cbu } = datosComprobante;
  const candidatos = [];

  // Búsqueda exacta por alias o CBU primero (más confiable)
  if (alias) {
    const rows = await query(
      `SELECT sa.*, dp.id as pedido_id, dp.nombre, dp.apellido, dp.email,
              dp.monto_total, dp.pagado, dp.estado
       FROM socios_alias sa
       LEFT JOIN datospedidos dp ON sa.pedido_id = dp.id
       WHERE LOWER(sa.alias_mp) = LOWER(?) AND sa.confirmado = 1`,
      [alias]
    );
    if (rows.length > 0) {
      return { match: rows[0], score: 1.0, tipo: 'alias_exacto', automatico: true };
    }
  }

  if (cbu) {
    const rows = await query(
      `SELECT sa.*, dp.id as pedido_id, dp.nombre, dp.apellido, dp.email
       FROM socios_alias sa
       LEFT JOIN datospedidos dp ON sa.pedido_id = dp.id
       WHERE sa.cbu = ? AND sa.confirmado = 1`,
      [cbu]
    );
    if (rows.length > 0) {
      return { match: rows[0], score: 1.0, tipo: 'cbu_exacto', automatico: true };
    }
  }

  // Búsqueda fuzzy por nombre en socios conocidos
  if (nombre) {
    const socios = await query(
      `SELECT sa.*, dp.id as pedido_id, dp.nombre as ped_nombre, dp.apellido as ped_apellido
       FROM socios_alias sa
       LEFT JOIN datospedidos dp ON sa.pedido_id = dp.id
       WHERE sa.confirmado = 1`
    );

    const fuse = new Fuse(socios, {
      keys: ['nombre_mp', 'nombre', 'apellido'],
      includeScore: true,
      threshold: 1 - THRESHOLD, // Fuse usa distancia (menor = mejor), convertimos
      ignoreLocation: true,
    });

    const resultados = fuse.search(nombre);
    if (resultados.length > 0) {
      const best = resultados[0];
      const score = 1 - best.score; // convertir a similitud
      if (score >= THRESHOLD) {
        return { match: best.item, score, tipo: 'nombre_fuzzy_socio', automatico: true };
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────
//  2. Buscar en datospedidos (pedidos pendientes)
// ──────────────────────────────────────────
async function buscarEnPedidos(datosComprobante) {
  const { nombre, monto } = datosComprobante;

  // Traer pedidos no pagados (o pendientes de confirmación)
  let sqlWhere = `WHERE (dp.pagado = 0 OR dp.pagado IS NULL) AND dp.estado NOT IN ('cancelado', 'anulado')`;
  const params = [];

  // Si tenemos monto, filtrar por pedidos con monto similar (±5%)
  if (monto) {
    sqlWhere += ` AND ABS(COALESCE(dp.total, dp.monto_total, 0) - ?) / GREATEST(COALESCE(dp.total, dp.monto_total, 0), 1) < 0.05`;
    params.push(monto);
  }

  const pedidos = await query(
    `SELECT dp.id, dp.nombre, dp.apellido, dp.email, dp.telefono, dp.dni,
            dp.pedidoID, dp.pagado, dp.estado, dp.estadoEnvio,
            CONCAT(COALESCE(dp.nombre,''), ' ', COALESCE(dp.apellido,'')) as nombre_completo
     FROM datospedidos dp
     ${sqlWhere}
     LIMIT 200`,
    params
  );

  if (!pedidos.length) return [];

  if (!nombre) return [];

  // Fuse.js sobre los pedidos
  const fuse = new Fuse(pedidos, {
    keys: [
      { name: 'nombre_completo', weight: 1.5 },
      { name: 'nombre', weight: 1 },
      { name: 'apellido', weight: 1 },
      { name: 'email', weight: 0.5 },
    ],
    includeScore: true,
    threshold: 0.6, // más permisivo acá, el admin confirma
    ignoreLocation: true,
  });

  const resultados = fuse.search(nombre);

  // Devolver top 3 candidatos con su score
  return resultados.slice(0, 3).map(r => ({
    pedido: r.item,
    score: 1 - r.score,
  }));
}

// ──────────────────────────────────────────
//  Función principal de matching
// ──────────────────────────────────────────
async function buscarMatch(datosComprobante) {
  logger.info('Iniciando matching para:', {
    nombre: datosComprobante.nombre,
    monto: datosComprobante.monto,
    alias: datosComprobante.alias
  });

  // Primero intentar con la tabla de socios (rápido y automático)
  const matchSocio = await buscarEnSocios(datosComprobante);
  if (matchSocio) {
    logger.info(`Match automático encontrado (score ${matchSocio.score.toFixed(2)}) via ${matchSocio.tipo}`);
    return {
      automatico: true,
      tipo: matchSocio.tipo,
      score: matchSocio.score,
      candidatos: [{ pedido: matchSocio.match, score: matchSocio.score }]
    };
  }

  // Sino, buscar en pedidos y pedir confirmación manual
  const candidatos = await buscarEnPedidos(datosComprobante);
  logger.info(`Matching manual: ${candidatos.length} candidatos encontrados`);

  return {
    automatico: false,
    tipo: 'busqueda_pedidos',
    candidatos
  };
}

// ──────────────────────────────────────────
//  Guardar aprendizaje en socios_alias
// ──────────────────────────────────────────
async function aprenderMatch(pedidoId, datosComprobante) {
  const { nombre, alias, cbu } = datosComprobante;

  // Buscar si ya existe un socio para este pedido
  const existente = await query(
    'SELECT id FROM socios_alias WHERE pedido_id = ?',
    [pedidoId]
  );

  if (existente.length > 0) {
    // Actualizar datos existentes
    await query(
      `UPDATE socios_alias 
       SET alias_mp = COALESCE(?, alias_mp),
           cbu = COALESCE(?, cbu),
           nombre_mp = COALESCE(?, nombre_mp),
           confirmado = 1,
           veces_usado = veces_usado + 1,
           actualizado = NOW()
       WHERE pedido_id = ?`,
      [alias || null, cbu || null, nombre || null, pedidoId]
    );
  } else {
    // Traer datos del pedido para completar la tabla
    const [pedido] = await query(
      'SELECT nombre, apellido, email, telefono, dni FROM datospedidos WHERE id = ?',
      [pedidoId]
    );

    if (pedido) {
      await query(
        `INSERT INTO socios_alias 
         (pedido_id, nombre, apellido, email, telefono, dni, alias_mp, cbu, nombre_mp, confirmado, veces_usado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        [
          pedidoId,
          pedido.nombre || null,
          pedido.apellido || null,
          pedido.email || null,
          pedido.telefono || null,
          pedido.dni || null,
          alias || null,
          cbu || null,
          nombre || null
        ]
      );
    }
  }

  logger.info(`✅ Match aprendido para pedidoID ${pedidoId}`);
}

module.exports = { buscarMatch, aprenderMatch, buscarEnPedidos, buscarEnSocios };
