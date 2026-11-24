// Datos para descargar los conteos (solo administrador). Solo incluye conteos FINALIZADOS.
// GET /api/exportar?action=lista[&sucursal=ID]
//     -> { finalizados: [...], abiertos: [...] }
// GET /api/exportar?action=filas&conteo=ID            -> filas de un conteo finalizado
// GET /api/exportar?action=filas&todos=1[&sucursal=ID] -> filas de todos los finalizados (consolidado)
const { query } = require('./_lib/db');
const { send, handler, httpError } = require('./_lib/http');
const { requireUser } = require('./_lib/auth');

function idOpcional(valor, mensaje) {
  if (valor === null || valor === '') return null;
  const n = Number.parseInt(valor, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(valor).trim()) throw httpError(400, mensaje);
  return n;
}

module.exports = handler(async (req, res) => {
  await requireUser(req, ['admin']);
  if (req.method !== 'GET') throw httpError(405, 'Método no permitido');
  const q = new URL(req.url, 'http://x').searchParams;
  const action = q.get('action');
  const sucursal = idOpcional(q.get('sucursal'), 'Sucursal inválida');

  if (action === 'lista') {
    const finalizados = await query(
      `SELECT c.id, s.nombre AS sucursal, ub.nombre AS ubicacion, u.nombre AS usuario, c.finalizado_en,
              count(DISTINCT l.articulo_id)::int AS articulos, COALESCE(sum(l.cantidad), 0)::float8 AS unidades
         FROM conteos c
         JOIN sucursales s ON s.id = c.sucursal_id
         JOIN ubicaciones ub ON ub.id = c.ubicacion_id
         JOIN usuarios u ON u.id = c.usuario_id
         LEFT JOIN conteo_lineas l ON l.conteo_id = c.id
        WHERE c.estado = 'finalizado' AND ($1::int IS NULL OR c.sucursal_id = $1)
        GROUP BY c.id, s.nombre, ub.nombre, u.nombre, c.finalizado_en
        ORDER BY c.finalizado_en DESC`, [sucursal]);
    const abiertos = await query(
      `SELECT c.id, s.nombre AS sucursal, ub.nombre AS ubicacion, u.nombre AS usuario, c.creado
         FROM conteos c
         JOIN sucursales s ON s.id = c.sucursal_id
         JOIN ubicaciones ub ON ub.id = c.ubicacion_id
         JOIN usuarios u ON u.id = c.usuario_id
        WHERE c.estado = 'abierto' AND ($1::int IS NULL OR c.sucursal_id = $1)
        ORDER BY c.creado`, [sucursal]);
    return send(res, 200, { finalizados, abiertos });
  }

  if (action === 'filas') {
    const conteo = idOpcional(q.get('conteo'), 'Conteo inválido');
    if (!conteo && q.get('todos') !== '1') throw httpError(400, 'Indique un conteo o todos=1');
    // Un conteo abierto nunca se exporta: solo c.estado = 'finalizado'
    const filas = await query(
      `SELECT c.id AS conteo_id, a.codigo, a.alterno, a.nombre, s.nombre AS sucursal,
              a.costo::float8 AS costo, a.existencia::float8 AS existencia,
              sum(l.cantidad)::float8 AS contado, ub.nombre AS ubicacion, u.nombre AS usuario, c.finalizado_en
         FROM conteos c
         JOIN conteo_lineas l ON l.conteo_id = c.id
         JOIN articulos a ON a.id = l.articulo_id
         JOIN sucursales s ON s.id = c.sucursal_id
         JOIN ubicaciones ub ON ub.id = c.ubicacion_id
         JOIN usuarios u ON u.id = c.usuario_id
        WHERE c.estado = 'finalizado'
          AND ($1::bigint IS NULL OR c.id = $1)
          AND ($2::int IS NULL OR c.sucursal_id = $2)
        GROUP BY c.id, a.id, s.nombre, ub.nombre, u.nombre, c.finalizado_en
        ORDER BY c.finalizado_en, ub.nombre, a.codigo`, [conteo, sucursal]);
    if (conteo && filas.length === 0) {
      const [c] = await query("SELECT estado FROM conteos WHERE id = $1", [conteo]);
      if (!c) throw httpError(404, 'El conteo no existe');
      if (c.estado !== 'finalizado') throw httpError(409, 'El conteo aún no está finalizado');
    }
    return send(res, 200, { filas });
  }

  throw httpError(404, 'Acción no encontrada');
});
