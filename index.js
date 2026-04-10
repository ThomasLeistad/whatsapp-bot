// src/index.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const logger = require('./utils/logger');
const { testConnection } = require('./db/connection');
const { runMigrations } = require('./db/migrations');
const { crearCliente, setIO } = require('./bot/whatsapp');
const apiRoutes = require('./routes/api');

// Crear directorios necesarios
const dirs = [
  process.env.COMPROBANTES_DIR || './comprobantes',
  process.env.SESSIONS_DIR || './sessions',
  './logs'
];
dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

async function main() {
  // ── 1. Verificar DB ──
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('No se pudo conectar a la base de datos. Verificá las variables de entorno DB_*');
    process.exit(1);
  }

  // ── 2. Migraciones ──
  await runMigrations();

  // ── 3. Express ──
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret: process.env.SESSION_SECRET || 'cambiar_esto_en_produccion',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
  }));

  // Servir dashboard estático
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // API routes
  app.use('/api', apiRoutes);

  // SPA fallback
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    logger.info(`🚀 Dashboard disponible en http://localhost:${PORT}`);
  });

  // ── 4. Socket.io ──
  setIO(io);
  io.on('connection', (socket) => {
    logger.info(`Dashboard conectado: ${socket.id}`);
  });

  // ── 5. Bot WhatsApp ──
  logger.info('Iniciando cliente WhatsApp...');
  const client = crearCliente();
  await client.initialize();
}

main().catch(err => {
  logger.error('Error fatal al iniciar:', err);
  process.exit(1);
});
