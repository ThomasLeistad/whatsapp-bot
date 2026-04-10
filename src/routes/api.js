// src/routes/api.js
const express = require('express');
const router  = express.Router();
const { query } = require('../db/connection');
const path      = require('path');
const fs        = require('fs');

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (req.session && req.session.autenticado) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// ── Stats del dashboard ──
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const [hoy] = await query(`
      SELECT
        SUM(estado='confirmado') as confirmados_hoy,
        SUM(estado='pendiente') as pendientes,
        SUM(estado='esperando_confirmacion') as esperando,
        SUM(estado='rechazado') as rechazados_hoy,
        SUM(estado='duplicado') as duplicados,
        COUNT(*) as total_hoy
      FROM comprobantes_pago
      WHERE DATE(creado) = CURDATE()
    `);

    const [semana] = await query(`
      SELECT COUNT(*) as total_semana,
             SUM(estado='confirmado') as confirmados_semana
      FROM comprobantes_pago
      WHERE creado >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);

    const [socios]   = await query('SELECT COUNT(*) as total_socios FROM socios_alias WHERE confirmado=1');
    const [montoHoy] = await query(`
      SELECT COALESCE(SUM(monto_extraido), 0) as monto_total
      FROM comprobantes_pago
      WHERE estado='confirmado' AND DATE(fecha_confirmacion) = CURDATE()
    `);

    res.json({ ...hoy, ...semana, ...socios, ...montoHoy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Listar comprobantes ──
router.get('/comprobantes', requireAuth, async (req, res) => {
  try {
    const { estado, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let where = '1=1';
    const params = [];
    if (estado) { where += ' AND cp.estado = ?'; params.push(estado); }

    const rows = await query(`
      SELECT cp.*,
             dp.nombre as pedido_nombre, dp.apellido as pedido_apellido,
             dp.pedidoID, dp.email as pedido_email
      FROM comprobantes_pago cp
      LEFT JOIN datospedidos dp ON cp.pedido_id_match = dp.id
      WHERE ${where}
      ORDER BY cp.creado DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM comprobantes_pago cp WHERE ${where}`, params
    );

    res.json({ rows, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Detalle de comprobante ──
router.get('/comprobantes/:id', requireAuth, async (req, res) => {
  try {
    const [comp] = await query(`
      SELECT cp.*, dp.nombre, dp.apellido, dp.email, dp.telefono, dp.pedidoID, dp.dni
      FROM comprobantes_pago cp
      LEFT JOIN datospedidos dp ON cp.pedido_id_match = dp.id
      WHERE cp.id = ?
    `, [req.params.id]);
    if (!comp) return res.status(404).json({ error: 'No encontrado' });
    res.json(comp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Listar socios alias ──
router.get('/socios', requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, q } = req.query;
    const offset = (page - 1) * limit;
    let where = '1=1';
    const params = [];
    if (q) {
      where += ' AND (sa.nombre LIKE ? OR sa.apellido LIKE ? OR sa.alias_mp LIKE ? OR sa.nombre_mp LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = await query(
      `SELECT sa.*, dp.pedidoID FROM socios_alias sa
       LEFT JOIN datospedidos dp ON sa.pedido_id = dp.id
       WHERE ${where} ORDER BY sa.veces_usado DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const [{ total }] = await query(`SELECT COUNT(*) as total FROM socios_alias sa WHERE ${where}`, params);
    res.json({ rows, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Confirmar manualmente desde dashboard ──
router.post('/comprobantes/:id/confirmar', requireAuth, async (req, res) => {
  try {
    const { pedido_id } = req.body;
    const id = req.params.id;

    await query(
      `UPDATE comprobantes_pago SET estado='confirmado', pedido_id_match=?, match_tipo='manual',
       confirmado_por='dashboard', fecha_confirmacion=NOW() WHERE id=?`,
      [pedido_id, id]
    );
    await query(
      `UPDATE datospedidos SET pagado=1, fechaPago=NOW(), comprobante=?, procesado=1 WHERE id=?`,
      [id, pedido_id]
    );

    const { aprenderMatch } = require('../matching/matcher');
    const [comp] = await query('SELECT * FROM comprobantes_pago WHERE id=?', [id]);
    await aprenderMatch(pedido_id, {
      nombre: comp.nombre_extraido,
      alias:  comp.alias_extraido,
      cbu:    comp.cbu_extraido
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Login / Logout / Me ──
router.post('/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (usuario === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
    req.session.autenticado = true;
    req.session.usuario     = usuario;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Credenciales incorrectas' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ autenticado: !!(req.session && req.session.autenticado) });
});

// ── Servir imagen del comprobante ──
router.get('/comprobantes/:id/imagen', requireAuth, async (req, res) => {
  try {
    const [comp] = await query(
      'SELECT archivo_path, tipo_archivo FROM comprobantes_pago WHERE id=?', [req.params.id]
    );
    if (!comp || !fs.existsSync(comp.archivo_path)) {
      return res.status(404).send('Archivo no encontrado');
    }
    res.sendFile(path.resolve(comp.archivo_path));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;
