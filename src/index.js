// src/index.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const { Server } = require('socket.io');

const logger      = require('./utils/logger');
const { testConnection } = require('./db/connection');
const { runMigrations }  = require('./db/migrations');
const { crearCliente, setIO } = require('./bot/whatsapp');
const apiRoutes   = require('./routes/api');

// Crear directorios necesarios
const dirs = [
  process.env.COMPROBANTES_DIR || './comprobantes',
  process.env.SESSIONS_DIR     || './sessions',
  process.env.LOGS_DIR         || './logs'
];
dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

async function main() {
  // ── 1. Verificar DB ──
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('No se pudo conectar a la base de datos. Verificá las variables DB_*');
    process.exit(1);
  }

  // ── 2. Migraciones ──
  await runMigrations();

  // ── 3. Express + Socket.io ──
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, { cors: { origin: '*' } });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret:            process.env.SESSION_SECRET || 'cambiar_esto_en_produccion',
    resave:            false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
  }));

  // Dashboard estático
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  app.use('/api', apiRoutes);

  // SPA fallback
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      const indexFile = path.join(publicDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.send('WhatsApp Bot corriendo. Dashboard no encontrado en /public/index.html');
      }
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    logger.info(`🚀 Dashboard en http://localhost:${PORT}`);
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
