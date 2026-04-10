// src/db/connection.js
require('dotenv').config();
const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset:  'utf8mb4',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  // Evitar desconexiones por idle
  enableKeepAlive:    true,
  keepAliveInitialDelay: 0,
});

/**
 * Ejecuta una query y devuelve los rows.
 * Para INSERT devuelve [ResultSetHeader, fields] — usá result.insertId.
 */
async function query(sql, params = []) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (err) {
    logger.error(`DB query error: ${err.message}`, { sql: sql.substring(0, 120) });
    throw err;
  }
}

/**
 * Verifica la conexión al arrancar.
 * Devuelve true si OK, false si falla.
 */
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    logger.info('✅ Conexión a MySQL exitosa');
    return true;
  } catch (err) {
    logger.error('❌ Error conectando a MySQL:', err.message);
    return false;
  }
}

module.exports = { query, pool, testConnection };
