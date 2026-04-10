// src/ocr/processor.js
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

// ──────────────────────────────────────────
//  Pre-procesado de imagen para mejor OCR
// ──────────────────────────────────────────
async function preprocesarImagen(inputPath) {
  const outputPath = inputPath.replace(/\.[^.]+$/, '_proc.png');
  await sharp(inputPath)
    .resize({ width: 1800, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toFile(outputPath);
  return outputPath;
}

// ──────────────────────────────────────────
//  Extraer texto con Tesseract
// ──────────────────────────────────────────
async function extraerTexto(imagePath) {
  const lang = process.env.TESSERACT_LANG || 'spa';
  logger.info(`OCR: procesando ${path.basename(imagePath)} con idioma ${lang}`);

  const imageProcesada = await preprocesarImagen(imagePath);
  const { data: { text } } = await Tesseract.recognize(imageProcesada, lang, {
    logger: m => {
      if (m.status === 'recognizing text') {
        logger.debug(`OCR progreso: ${Math.round(m.progress * 100)}%`);
      }
    }
  });

  // Limpiar imagen temporal
  try { fs.unlinkSync(imageProcesada); } catch (_) {}

  logger.info(`OCR: texto extraído (${text.length} chars)`);
  return text;
}

// ──────────────────────────────────────────
//  Parsear datos del comprobante
// ──────────────────────────────────────────
function parsearComprobante(texto) {
  const t = texto;
  const resultado = {
    monto: null,
    nombre: null,
    alias: null,
    cbu: null,
    nroTransaccion: null,
    fechaPago: null,
    textoRaw: t
  };

  // --- MONTO ---
  // Patrones: $ 1.500,00 | $1500 | 1.500,00 | $ 1.500
  const montoPatterns = [
    /\$\s*([\d\.]+,\d{2})/,
    /\$\s*([\d\.]+)/,
    /(?:monto|importe|total)[:\s]+\$?\s*([\d\.]+(?:,\d{2})?)/i,
    /(?:transferiste|enviaste|pagaste)[^\$]*\$\s*([\d\.]+(?:,\d{2})?)/i,
  ];
  for (const p of montoPatterns) {
    const m = t.match(p);
    if (m) {
      resultado.monto = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      break;
    }
  }

  // --- NOMBRE / ALIAS en MP ---
  // "Para: Juan Pérez", "A: Juan Pérez", "Alias: juan.perez"
  const nombrePatterns = [
    /(?:para|a|destinatario|pagaste a)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{3,50})/i,
    /(?:de|remitente|enviado por|pagador)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{3,50})/i,
    /nombre[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{3,50})/i,
  ];
  for (const p of nombrePatterns) {
    const m = t.match(p);
    if (m) {
      resultado.nombre = m[1].trim().replace(/\s+/g, ' ');
      break;
    }
  }

  // --- ALIAS ---
  // Alias MP: letras, números y puntos, mínimo 6 chars
  const aliasMatch = t.match(/(?:alias)[:\s]+([a-záéíóúñA-ZÁÉÍÓÚÑ0-9.\-]{4,30})/i);
  if (aliasMatch) resultado.alias = aliasMatch[1].trim().toLowerCase();

  // --- CBU / CVU ---
  const cbuMatch = t.match(/(?:CBU|CVU)[:\s]*(\d{22})/i);
  if (cbuMatch) resultado.cbu = cbuMatch[1];

  // --- NRO TRANSACCIÓN ---
  const txPatterns = [
    /(?:n[°º]?\s*op(?:eración)?|transacci[oó]n|comprobante|referencia)[:\s#]*(\d{6,20})/i,
    /(?:ID)[:\s]+(\d{6,20})/i,
  ];
  for (const p of txPatterns) {
    const m = t.match(p);
    if (m) { resultado.nroTransaccion = m[1]; break; }
  }

  // --- FECHA ---
  const fechaPatterns = [
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/,
    /(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+(?:de\s+)?(\d{4})/i,
  ];
  for (const p of fechaPatterns) {
    const m = t.match(p);
    if (m) {
      resultado.fechaPago = m[0];
      break;
    }
  }

  logger.info('OCR parseado:', {
    monto: resultado.monto,
    nombre: resultado.nombre,
    alias: resultado.alias,
    nroTransaccion: resultado.nroTransaccion
  });

  return resultado;
}

// ──────────────────────────────────────────
//  Hash del archivo para anti-duplicados
// ──────────────────────────────────────────
function calcularHash(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ──────────────────────────────────────────
//  Función principal
// ──────────────────────────────────────────
async function procesarComprobante(filePath) {
  const hash = calcularHash(filePath);
  const texto = await extraerTexto(filePath);
  const datos = parsearComprobante(texto);
  return { ...datos, hash };
}

module.exports = { procesarComprobante, extraerTexto, parsearComprobante, calcularHash };
