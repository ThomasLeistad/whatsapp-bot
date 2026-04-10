// src/ocr/processor.js
const Tesseract = require('tesseract.js');
const sharp     = require('sharp');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const logger    = require('../utils/logger');

// ──────────────────────────────────────────
//  Convertir PDF a imagen para OCR
// ──────────────────────────────────────────
async function pdfAImagen(pdfPath) {
  // Usamos pdftoppm (poppler-utils) instalado en el Dockerfile
  const { execSync } = require('child_process');
  const outputBase = pdfPath.replace(/\.pdf$/i, '_page');
  
  try {
    execSync(`pdftoppm -r 200 -l 1 -png "${pdfPath}" "${outputBase}"`, { timeout: 30000 });
    
    // pdftoppm genera outputBase-1.png (o -01.png según versión)
    const candidates = [
      `${outputBase}-1.png`,
      `${outputBase}-01.png`,
      `${outputBase}-001.png`,
    ];
    
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        logger.info(`PDF convertido a imagen: ${c}`);
        return c;
      }
    }
    throw new Error('pdftoppm no generó el archivo esperado');
  } catch (err) {
    logger.error('Error convirtiendo PDF:', err.message);
    throw new Error(`No se pudo convertir el PDF: ${err.message}`);
  }
}

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
async function extraerTexto(filePath) {
  const lang = process.env.TESSERACT_LANG || 'spa';
  let imagePath = filePath;
  let tempPdfImg = null;

  // Si es PDF, convertir primero
  if (filePath.toLowerCase().endsWith('.pdf')) {
    tempPdfImg = await pdfAImagen(filePath);
    imagePath = tempPdfImg;
  }

  logger.info(`OCR: procesando ${path.basename(imagePath)} con idioma ${lang}`);
  const imageProcesada = await preprocesarImagen(imagePath);

  const { data: { text } } = await Tesseract.recognize(imageProcesada, lang, {
    logger: m => {
      if (m.status === 'recognizing text') {
        logger.debug(`OCR progreso: ${Math.round(m.progress * 100)}%`);
      }
    }
  });

  // Limpiar temporales
  try { fs.unlinkSync(imageProcesada); } catch (_) {}
  if (tempPdfImg) try { fs.unlinkSync(tempPdfImg); } catch (_) {}

  logger.info(`OCR: texto extraído (${text.length} chars)`);
  return text;
}

// ──────────────────────────────────────────
//  Parsear datos del comprobante
// ──────────────────────────────────────────
function parsearComprobante(texto) {
  const t = texto;
  const resultado = {
    monto:          null,
    nombre:         null,
    alias:          null,
    cbu:            null,
    nroTransaccion: null,
    fechaPago:      null,
    textoRaw:       t
  };

  // --- MONTO ---
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

  // --- NOMBRE ---
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
    if (m) { resultado.fechaPago = m[0]; break; }
  }

  logger.info('OCR parseado:', {
    monto:          resultado.monto,
    nombre:         resultado.nombre,
    alias:          resultado.alias,
    nroTransaccion: resultado.nroTransaccion
  });

  return resultado;
}

// ──────────────────────────────────────────
//  Hash anti-duplicados
// ──────────────────────────────────────────
function calcularHash(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ──────────────────────────────────────────
//  Función principal
// ──────────────────────────────────────────
async function procesarComprobante(filePath) {
  const hash   = calcularHash(filePath);
  const texto  = await extraerTexto(filePath);
  const datos  = parsearComprobante(texto);
  return { ...datos, hash };
}

module.exports = { procesarComprobante, extraerTexto, parsearComprobante, calcularHash };
