const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db');
const { httpError } = require('./http');

const COOKIE = 'cf_session';
const DURACION_SEG = 12 * 60 * 60;          // 12 horas
const MAX_INTENTOS = 5;
const BLOQUEO_MIN = 15;

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_SECRET debe existir y tener al menos 32 caracteres');
  return s;
}

function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

function validarPassword(plain) {
  const p = String(plain ?? '');
  if (p.length < 8) throw httpError(400, 'La contraseña debe tener al menos 8 caracteres');
  if (p.length > 100) throw httpError(400, 'La contraseña es demasiado larga');
  return p;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
}

function setSessionCookie(req, res, userId) {
  const token = jwt.sign({ uid: userId }, secret(), { expiresIn: DURACION_SEG });
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${DURACION_SEG}`];
  if (isSecure(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${flags.join('; ')}`);
}

function clearSessionCookie(req, res) {
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (isSecure(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE}=; ${flags.join('; ')}`);
}

// Rechaza peticiones que cambian datos y vienen de otro origen (defensa CSRF adicional a SameSite)
function checkOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw httpError(403, 'Origen no permitido');
}

// Devuelve el usuario autenticado (consulta la BD en cada petición: un usuario desactivado pierde acceso al instante)
async function requireUser(req, roles) {
  checkOrigin(req);
  const token = parseCookies(req)[COOKIE];
  if (!token) throw httpError(401, 'No ha iniciado sesión');
  let payload;
  try { payload = jwt.verify(token, secret()); } catch { throw httpError(401, 'Sesión vencida'); }
  const rows = await query(
    `SELECT u.id, u.usuario, u.nombre, u.rol, u.sucursal_id, u.activo, s.nombre AS sucursal
       FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id WHERE u.id = $1`,
    [payload.uid]);
  const u = rows[0];
  if (!u || !u.activo) throw httpError(401, 'Usuario inactivo');
  if (roles && !roles.includes(u.rol)) throw httpError(403, 'No tiene permiso para esta acción');
  return u;
}

// Verifica usuario y contraseña con bloqueo temporal tras varios intentos fallidos
async function login(usuario, password) {
  const nombre = String(usuario ?? '').trim().toLowerCase();
  const rows = await query('SELECT * FROM usuarios WHERE usuario = $1', [nombre]);
  const u = rows[0];
  const generico = httpError(401, 'Usuario o contraseña incorrectos');
  if (!u || !u.activo) {
    await bcrypt.compare(String(password ?? ''), '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali'); // tiempo similar
    throw generico;
  }
  if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) {
    throw httpError(429, `Cuenta bloqueada temporalmente. Intente en ${BLOQUEO_MIN} minutos`);
  }
  const ok = await bcrypt.compare(String(password ?? ''), u.pass_hash);
  if (!ok) {
    await query(
      `UPDATE usuarios SET intentos_fallidos = intentos_fallidos + 1,
         bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE bloqueado_hasta END
       WHERE id = $1`, [u.id, MAX_INTENTOS, String(BLOQUEO_MIN)]);
    throw generico;
  }
  await query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [u.id]);
  return u;
}

module.exports = {
  hashPassword, validarPassword, requireUser, login,
  setSessionCookie, clearSessionCookie, checkOrigin
};
