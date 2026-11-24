// Conteo físico (operador o administrador)
// GET  /api/conteo?action=actual     -> conteo abierto del usuario (o null)
// POST /api/conteo?action=iniciar    { ubicacion_id }
// GET  /api/conteo?action=articulos  -> artículos de la sucursal + lo contado en este conteo
// POST /api/conteo?action=guardar    { articulo_id, parciales: [{ cantidad, detalle }] }  (reemplaza lo anterior de ese artículo)
// POST /api/conteo?action=finalizar  -> cierra el conteo
const { query } = require('./_lib/db');
const { send, readJson, handler, httpError } = require('./_lib/http');
const { requireUser } = require('./_lib/auth');

const MAX_PARCIALES = 200;

async function conteoAbierto(userId) {
  const rows = await query(
    `SELECT c.id, c.sucursal_id, s.nombre AS sucursal, c.ubicacion_id, ub.nombre AS ubicacion, c.creado
       FROM conteos c
       JOIN sucursales s ON s.id = c.sucursal_id
       JOIN ubicaciones ub ON ub.id = c.ubicacion_id
      WHERE c.usuario_id = $1 AND c.estado = 'abierto'`, [userId]);
  return rows[0] || null;
}

function entero(v, mensaje) {
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, mensaje);
  return n;
}

module.exports = handler(async (req, res) => {
  const user = await requireUser(req);
  const action = new URL(req.url, 'http://x').searchParams.get('action');

  if (action === 'actual' && req.method === 'GET') {
    return send(res, 200, { conteo: await conteoAbierto(user.id) });
  }

  if (action === 'iniciar' && req.method === 'POST') {
    const ubicacionId = entero((await readJson(req)).ubicacion_id, 'Ubicación inválida');
    const [ub] = await query('SELECT id, sucursal_id FROM ubicaciones WHERE id = $1', [ubicacionId]);
    if (!ub) throw httpError(404, 'La ubicación no existe');
    if (user.rol === 'operador' && user.sucursal_id && user.sucursal_id !== ub.sucursal_id) {
      throw httpError(403, 'No tiene acceso a esa sucursal');
    }
    const existente = await conteoAbierto(user.id);
    if (existente) {
      if (existente.ubicacion_id === ubicacionId) return send(res, 200, { conteo: existente });
      throw httpError(409, `Ya tiene un conteo abierto en ${existente.sucursal} / ${existente.ubicacion}. Finalícelo primero.`);
    }
    try {
      await query('INSERT INTO conteos (sucursal_id, ubicacion_id, usuario_id) VALUES ($1, $2, $3)',
        [ub.sucursal_id, ubicacionId, user.id]);
    } catch (e) {
      if (!/duplicate|unique/i.test(String(e.message))) throw e;   // doble clic: el índice único evita dos abiertos
    }
    return send(res, 201, { conteo: await conteoAbierto(user.id) });
  }

  // Desde aquí se requiere un conteo abierto
  const conteo = await conteoAbierto(user.id);
  if (!conteo) throw httpError(409, 'No tiene un conteo abierto');

  if (action === 'articulos' && req.method === 'GET') {
    const articulos = await query(
      `SELECT id, codigo, alterno, nombre, costo::float8 AS costo, existencia::float8 AS existencia
         FROM articulos WHERE sucursal_id = $1 ORDER BY codigo`, [conteo.sucursal_id]);
    const lineas = await query(
      `SELECT id, articulo_id, cantidad::float8 AS cantidad, detalle
         FROM conteo_lineas WHERE conteo_id = $1 ORDER BY id`, [conteo.id]);
    return send(res, 200, { conteo, articulos, lineas });
  }

  if (action === 'guardar' && req.method === 'POST') {
    const b = await readJson(req);
    const articuloId = entero(b.articulo_id, 'Artículo inválido');
    const parciales = Array.isArray(b.parciales) ? b.parciales : null;
    if (!parciales || parciales.length > MAX_PARCIALES) throw httpError(400, 'Lista de conteos inválida');
    const cantidades = [], detalles = [];
    for (const p of parciales) {
      const q = typeof p?.cantidad === 'number' ? p.cantidad : Number(p?.cantidad);
      if (!Number.isFinite(q) || q < 0 || q > 1e8) throw httpError(400, 'Cantidad inválida');
      cantidades.push(Math.round(q * 100) / 100);
      detalles.push(String(p?.detalle ?? '').trim().slice(0, 100));
    }
    // Una sola sentencia: borra lo anterior de ese artículo e inserta lo nuevo (atómico).
    // Solo actúa si el conteo sigue abierto, es del usuario y el artículo es de la misma sucursal.
    const [r] = await query(
      `WITH c AS (
         SELECT id, sucursal_id FROM conteos WHERE id = $1 AND usuario_id = $2 AND estado = 'abierto'
       ), a AS (
         SELECT a.id FROM articulos a JOIN c ON c.sucursal_id = a.sucursal_id WHERE a.id = $3
       ), del AS (
         DELETE FROM conteo_lineas
          WHERE conteo_id IN (SELECT id FROM c) AND articulo_id IN (SELECT id FROM a) RETURNING 1
       ), ins AS (
         INSERT INTO conteo_lineas (conteo_id, articulo_id, cantidad, detalle)
         SELECT c.id, a.id, t.q, t.d FROM c, a, unnest($4::numeric[], $5::text[]) AS t(q, d)
         RETURNING id, cantidad::float8 AS cantidad, detalle
       )
       SELECT (SELECT count(*) FROM c)::int AS conteo_ok,
              (SELECT count(*) FROM a)::int AS articulo_ok,
              (SELECT COALESCE(json_agg(json_build_object('id', id, 'cantidad', cantidad, 'detalle', detalle)), '[]'::json) FROM ins) AS lineas`,
      [conteo.id, user.id, articuloId, cantidades, detalles]);
    if (!r.conteo_ok) throw httpError(409, 'El conteo ya fue finalizado');
    if (!r.articulo_ok) throw httpError(404, 'El artículo no pertenece a esta sucursal');
    return send(res, 200, { lineas: typeof r.lineas === 'string' ? JSON.parse(r.lineas) : r.lineas });
  }

  if (action === 'finalizar' && req.method === 'POST') {
    const rows = await query(
      `UPDATE conteos SET estado = 'finalizado', finalizado_en = now()
        WHERE id = $1 AND usuario_id = $2 AND estado = 'abierto' RETURNING id`, [conteo.id, user.id]);
    if (!rows.length) throw httpError(409, 'El conteo ya fue finalizado');
    const [{ n, total }] = await query(
      `SELECT count(DISTINCT articulo_id)::int AS n, COALESCE(sum(cantidad), 0)::float8 AS total
         FROM conteo_lineas WHERE conteo_id = $1`, [conteo.id]);
    return send(res, 200, { ok: true, conteo_id: conteo.id, articulos_contados: n, unidades: total });
  }

  throw httpError(404, 'Acción no encontrada');
});
