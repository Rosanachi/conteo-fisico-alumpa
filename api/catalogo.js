// GET /api/catalogo            -> sucursales permitidas al usuario
// GET /api/catalogo?sucursal=ID -> ubicaciones de esa sucursal (si el usuario puede acceder a ella)
const { query } = require('./_lib/db');
const { send, handler, httpError } = require('./_lib/http');
const { requireUser } = require('./_lib/auth');

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') throw httpError(405, 'Método no permitido');
  const u = await requireUser(req);
  const sucId = new URL(req.url, 'http://x').searchParams.get('sucursal');

  // Operador con sucursal fija: solo ve la suya. Admin y operadores sin sucursal fija: todas.
  const restringido = u.rol === 'operador' && u.sucursal_id;

  if (!sucId) {
    const rows = restringido
      ? await query('SELECT id, nombre FROM sucursales WHERE id = $1', [u.sucursal_id])
      : await query('SELECT id, nombre FROM sucursales ORDER BY nombre');
    return send(res, 200, { sucursales: rows });
  }

  const id = Number.parseInt(sucId, 10);
  if (!Number.isInteger(id)) throw httpError(400, 'Sucursal inválida');
  if (restringido && id !== u.sucursal_id) throw httpError(403, 'No tiene acceso a esa sucursal');
  const rows = await query('SELECT id, nombre FROM ubicaciones WHERE sucursal_id = $1 ORDER BY orden', [id]);
  send(res, 200, { ubicaciones: rows });
});
