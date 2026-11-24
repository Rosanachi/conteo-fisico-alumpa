// Inicialización única: crea tablas, sucursales/ubicaciones y el primer administrador.
// Protegida con la variable de entorno SETUP_TOKEN. Es segura de repetir (idempotente).
const crypto = require('crypto');
const { query } = require('./_lib/db');
const { send, readJson, handler, httpError } = require('./_lib/http');
const { hashPassword, validarPassword } = require('./_lib/auth');
const SCHEMA = require('./_lib/schema');
const { SEED } = require('./_lib/seed');

function tokenOk(recibido) {
  const esperado = process.env.SETUP_TOKEN || '';
  if (esperado.length < 16) throw httpError(503, 'SETUP_TOKEN no configurado (mínimo 16 caracteres)');
  const a = Buffer.from(String(recibido || ''));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sembrar() {
  for (const [nombre, ubicaciones] of Object.entries(SEED)) {
    await query('INSERT INTO sucursales (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [nombre]);
    const [{ id }] = await query('SELECT id FROM sucursales WHERE nombre = $1', [nombre]);
    await query(
      `INSERT INTO ubicaciones (sucursal_id, nombre, orden)
       SELECT $1, n, o FROM unnest($2::text[], $3::int[]) AS t(n, o)
       ON CONFLICT (sucursal_id, nombre) DO NOTHING`,
      [id, ubicaciones, ubicaciones.map((_, i) => i + 1)]);
  }
}

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpError(405, 'Método no permitido');
  if (!tokenOk(req.headers['x-setup-token'])) throw httpError(403, 'Token de inicialización incorrecto');
  const body = await readJson(req);

  for (const sentencia of SCHEMA) await query(sentencia);
  await sembrar();

  let adminCreado = false;
  const [{ n }] = await query("SELECT count(*)::int AS n FROM usuarios WHERE rol = 'admin'");
  if (n === 0) {
    const usuario = String(body.usuario || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw httpError(400, 'Usuario inválido (3 a 30 letras, números . _ -)');
    const pass = validarPassword(body.password);
    await query(
      `INSERT INTO usuarios (usuario, nombre, pass_hash, rol) VALUES ($1, $2, $3, 'admin')`,
      [usuario, String(body.nombre || usuario).trim().slice(0, 80), await hashPassword(pass)]);
    adminCreado = true;
  }

  const [{ s }] = await query('SELECT count(*)::int AS s FROM sucursales');
  const [{ u }] = await query('SELECT count(*)::int AS u FROM ubicaciones');
  send(res, 200, { ok: true, sucursales: s, ubicaciones: u, adminCreado });
});
