// Inventario teórico (solo administrador)
// POST /api/inventario?action=cargar   { filas: [{ sucursal, codigo, alterno, nombre, costo, existencia }] }
//      Actualiza (por sucursal + código) o inserta. Se puede repetir sin duplicar.
// GET  /api/inventario?action=resumen  -> artículos por sucursal
const { query } = require('./_lib/db');
const { send, readJson, handler, httpError } = require('./_lib/http');
const { requireUser } = require('./_lib/auth');

const MAX_FILAS = 2000;

const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const texto = (v, max) => String(v ?? '').trim().slice(0, max);

function numero(v, { min, max }) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 10000) / 10000;
}

module.exports = handler(async (req, res) => {
  await requireUser(req, ['admin']);
  const action = new URL(req.url, 'http://x').searchParams.get('action');

  if (action === 'resumen' && req.method === 'GET') {
    const rows = await query(
      `SELECT s.id, s.nombre, count(a.id)::int AS articulos
         FROM sucursales s LEFT JOIN articulos a ON a.sucursal_id = s.id
        GROUP BY s.id, s.nombre ORDER BY s.nombre`);
    return send(res, 200, { sucursales: rows });
  }

  if (action === 'cargar' && req.method === 'POST') {
    const { filas } = await readJson(req);
    if (!Array.isArray(filas) || filas.length === 0) throw httpError(400, 'No hay filas para cargar');
    if (filas.length > MAX_FILAS) throw httpError(400, `Máximo ${MAX_FILAS} filas por envío`);

    const sucursales = await query('SELECT id, nombre FROM sucursales');
    const porNombre = new Map(sucursales.map(s => [norm(s.nombre), s.id]));

    const validas = new Map();        // "sucursal|codigo" -> fila (si se repite, gana la última)
    const errores = [];
    filas.forEach((f, i) => {
      const fila = Number.isInteger(f?.fila) ? f.fila : i + 1;
      const sucursalId = porNombre.get(norm(f?.sucursal));
      const codigo = texto(f?.codigo, 60);
      const costo = numero(f?.costo, { min: 0, max: 1e9 });
      const existencia = numero(f?.existencia, { min: -1e9, max: 1e9 });
      if (!sucursalId) return errores.push({ fila, error: `Sucursal desconocida: "${texto(f?.sucursal, 40)}"` });
      if (!codigo) return errores.push({ fila, error: 'Código vacío' });
      if (costo === null) return errores.push({ fila, error: 'Costo inválido' });
      if (existencia === null) return errores.push({ fila, error: 'Existencia inválida' });
      validas.set(`${sucursalId}|${codigo}`, {
        sucursalId, codigo, alterno: texto(f?.alterno, 60), nombre: texto(f?.nombre, 200),
        costo, existencia: Math.round(existencia * 100) / 100
      });
    });

    let insertados = 0, actualizados = 0;
    if (validas.size) {
      const v = [...validas.values()];
      const rows = await query(
        `INSERT INTO articulos (sucursal_id, codigo, alterno, nombre, costo, existencia)
         SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[])
         ON CONFLICT (sucursal_id, codigo) DO UPDATE
           SET alterno = EXCLUDED.alterno, nombre = EXCLUDED.nombre,
               costo = EXCLUDED.costo, existencia = EXCLUDED.existencia
         RETURNING (xmax = 0) AS insertado`,
        [v.map(x => x.sucursalId), v.map(x => x.codigo), v.map(x => x.alterno),
         v.map(x => x.nombre), v.map(x => x.costo), v.map(x => x.existencia)]);
      insertados = rows.filter(r => r.insertado).length;
      actualizados = rows.length - insertados;
    }
    return send(res, 200, { insertados, actualizados, rechazadas: errores.length, errores: errores.slice(0, 50) });
  }

  throw httpError(404, 'Acción no encontrada');
});
