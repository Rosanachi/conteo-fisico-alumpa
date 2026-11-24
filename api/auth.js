// /api/auth?action=login | logout | me
const { query } = require('./_lib/db');
const { send, readJson, handler, httpError } = require('./_lib/http');
const { login, requireUser, setSessionCookie, clearSessionCookie, checkOrigin } = require('./_lib/auth');

function publico(u) {
  return { id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, sucursal_id: u.sucursal_id, sucursal: u.sucursal || null };
}

module.exports = handler(async (req, res) => {
  const action = new URL(req.url, 'http://x').searchParams.get('action');

  if (action === 'login' && req.method === 'POST') {
    checkOrigin(req);
    const { usuario, password } = await readJson(req);
    const u = await login(usuario, password);
    setSessionCookie(req, res, u.id);
    const [conSucursal] = await query(
      `SELECT u.*, s.nombre AS sucursal FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id WHERE u.id = $1`, [u.id]);
    return send(res, 200, { usuario: publico(conSucursal) });
  }

  if (action === 'logout' && req.method === 'POST') {
    checkOrigin(req);
    clearSessionCookie(req, res);
    return send(res, 200, { ok: true });
  }

  if (action === 'me' && req.method === 'GET') {
    const u = await requireUser(req);
    return send(res, 200, { usuario: publico(u) });
  }

  throw httpError(404, 'Acción no encontrada');
});
