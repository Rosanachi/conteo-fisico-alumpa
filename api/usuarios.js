// Gestión de usuarios (solo administrador)
// GET  /api/usuarios                     -> lista
// POST /api/usuarios?action=crear        -> { usuario, nombre, password, rol, sucursal_id? }
// POST /api/usuarios?action=actualizar   -> { id, activo?, password?, sucursal_id?, nombre? }
const { query } = require('./_lib/db');
const { send, readJson, handler, httpError } = require('./_lib/http');
const { requireUser, hashPassword, validarPassword } = require('./_lib/auth');

const COLUMNAS = `u.id, u.usuario, u.nombre, u.rol, u.activo, u.sucursal_id, s.nombre AS sucursal`;

async function sucursalValida(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const id = Number.parseInt(valor, 10);
  const rows = Number.isInteger(id) ? await query('SELECT id FROM sucursales WHERE id = $1', [id]) : [];
  if (!rows.length) throw httpError(400, 'Sucursal inexistente');
  return id;
}

module.exports = handler(async (req, res) => {
  const admin = await requireUser(req, ['admin']);
  const action = new URL(req.url, 'http://x').searchParams.get('action');

  if (req.method === 'GET') {
    const rows = await query(
      `SELECT ${COLUMNAS} FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id ORDER BY u.rol, u.usuario`);
    return send(res, 200, { usuarios: rows });
  }

  if (req.method !== 'POST') throw httpError(405, 'Método no permitido');
  const b = await readJson(req);

  if (action === 'crear') {
    const usuario = String(b.usuario || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw httpError(400, 'Usuario inválido (3 a 30 letras, números . _ -)');
    const nombre = String(b.nombre || '').trim().slice(0, 80);
    if (!nombre) throw httpError(400, 'El nombre es obligatorio');
    if (!['admin', 'operador'].includes(b.rol)) throw httpError(400, 'Rol inválido');
    const pass = validarPassword(b.password);
    const sucursal = b.rol === 'operador' ? await sucursalValida(b.sucursal_id) : null;
    try {
      await query(
        'INSERT INTO usuarios (usuario, nombre, pass_hash, rol, sucursal_id) VALUES ($1, $2, $3, $4, $5)',
        [usuario, nombre, await hashPassword(pass), b.rol, sucursal]);
    } catch (e) {
      if (/duplicate|unique/i.test(String(e.message))) throw httpError(409, 'Ese usuario ya existe');
      throw e;
    }
    return send(res, 201, { ok: true });
  }

  if (action === 'actualizar') {
    const id = Number.parseInt(b.id, 10);
    if (!Number.isInteger(id)) throw httpError(400, 'Usuario inválido');
    const [objetivo] = await query('SELECT id, rol FROM usuarios WHERE id = $1', [id]);
    if (!objetivo) throw httpError(404, 'Usuario no encontrado');
    if (id === admin.id && b.activo === false) throw httpError(400, 'No puede desactivar su propio usuario');

    if (typeof b.activo === 'boolean') {
      await query('UPDATE usuarios SET activo = $2 WHERE id = $1', [id, b.activo]);
    }
    if (b.password) {
      await query('UPDATE usuarios SET pass_hash = $2, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1',
        [id, await hashPassword(validarPassword(b.password))]);
    }
    if ('sucursal_id' in b && objetivo.rol === 'operador') {
      await query('UPDATE usuarios SET sucursal_id = $2 WHERE id = $1', [id, await sucursalValida(b.sucursal_id)]);
    }
    if (b.nombre) {
      await query('UPDATE usuarios SET nombre = $2 WHERE id = $1', [id, String(b.nombre).trim().slice(0, 80)]);
    }
    return send(res, 200, { ok: true });
  }

  throw httpError(404, 'Acción no encontrada');
});
