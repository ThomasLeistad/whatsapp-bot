// src/db/migrations.js
// Crea las tablas propias del bot si no existen
const { query } = require('./connection');
const logger    = require('../utils/logger');

const migrations = [
  // Tabla SOCIOS: aprende los alias/CBU de cada cliente para matching automático futuro
  `CREATE TABLE IF NOT EXISTS socios_alias (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    pedido_id     INT NULL,
    nombre        VARCHAR(255) NOT NULL,
    apellido      VARCHAR(255) NULL,
    email         VARCHAR(255) NULL,
    dni           VARCHAR(30) NULL,
    alias_mp      VARCHAR(255) NULL COMMENT 'Alias de Mercado Pago',
    cbu           VARCHAR(50) NULL COMMENT 'CBU o CVU',
    nombre_mp     VARCHAR(255) NULL COMMENT 'Nombre tal como aparece en comprobantes MP',
    telefono      VARCHAR(50) NULL,
    confirmado    TINYINT(1) DEFAULT 0 COMMENT '1 = admin confirmó el match manualmente',
    veces_usado   INT DEFAULT 0,
    creado        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actualizado   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_alias   (alias_mp),
    INDEX idx_cbu     (cbu),
    INDEX idx_nombre  (nombre_mp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Tabla de comprobantes procesados
  `CREATE TABLE IF NOT EXISTS comprobantes_pago (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    whatsapp_from       VARCHAR(50) NOT NULL,
    archivo_nombre      VARCHAR(255) NOT NULL,
    archivo_path        VARCHAR(500) NOT NULL,
    tipo_archivo        ENUM('imagen','pdf') NOT NULL,

    -- Datos extraídos por OCR
    ocr_texto_raw       TEXT NULL,
    monto_extraido      DECIMAL(10,2) NULL,
    nombre_extraido     VARCHAR(255) NULL,
    alias_extraido      VARCHAR(255) NULL,
    cbu_extraido        VARCHAR(50) NULL,
    nro_transaccion     VARCHAR(100) NULL,
    fecha_pago_extraida DATE NULL,

    -- Resultado del matching
    pedido_id_match     INT NULL,
    match_score         DECIMAL(5,4) NULL,
    match_tipo          ENUM('automatico','manual','fallido') NULL,

    -- Estado del flujo
    estado              ENUM('pendiente','esperando_confirmacion','confirmado','rechazado','duplicado','error_ocr') DEFAULT 'pendiente',

    -- Quién confirmó
    confirmado_por      VARCHAR(50) NULL,
    fecha_confirmacion  TIMESTAMP NULL,

    -- Anti-duplicados
    hash_comprobante    VARCHAR(64) NULL UNIQUE,

    creado              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actualizado         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_estado    (estado),
    INDEX idx_pedido    (pedido_id_match),
    INDEX idx_whatsapp  (whatsapp_from)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Sesiones de confirmación (diálogo activo con el admin)
  `CREATE TABLE IF NOT EXISTS sesiones_confirmacion (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    comprobante_id    INT NOT NULL,
    admin_whatsapp    VARCHAR(50) NOT NULL,
    estado            ENUM('esperando','respondido','timeout') DEFAULT 'esperando',
    opciones_json     JSON NULL,
    respuesta         VARCHAR(50) NULL,
    creado            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expira            TIMESTAMP NULL,
    FOREIGN KEY (comprobante_id) REFERENCES comprobantes_pago(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Log de actividad
  `CREATE TABLE IF NOT EXISTS bot_log (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    nivel   ENUM('info','warn','error') DEFAULT 'info',
    evento  VARCHAR(100) NOT NULL,
    detalle TEXT NULL,
    whatsapp VARCHAR(50) NULL,
    creado  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_creado (creado),
    INDEX idx_evento (evento)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function runMigrations() {
  logger.info('Ejecutando migraciones de base de datos...');
  for (const sql of migrations) {
    try {
      await query(sql);
    } catch (err) {
      logger.error('Error en migración:', err.message);
      throw err;
    }
  }
  logger.info('✅ Migraciones completadas');
}

module.exports = { runMigrations };
