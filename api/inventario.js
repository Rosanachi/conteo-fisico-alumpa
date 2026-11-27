// Inventario teórico (solo administrador)
// POST /api/inventario?action=cargar   { filas: [{ sucursal, codigo, alterno, nombre, costo, existencia }] }
//      Actualiza (por sucursal + código) o inserta. Se puede repetir sin duplicar.
// GET  /api/inventario?action=resumen  -> artículos por sucursal
// GET  /api/inventario?action=buscar&sucursal=ID&q=texto   -> hasta 50 artículos (código, alterno o nombre)
// GET  /api/inventario?action=listado&sucursal=ID          -> todos los artículos (respaldo antes de borrar)
// POST /api/inventario?action=borrar        { ids: [..] }                       -> borra esos artículos
// POST /api/inventario?action=borrar-todos  { sucursal_id?, confirmar: 'BORRAR' } -> borra el listado
//      Los artículos que aparecen en algún conteo (en curso o finalizado) NO se borran: se informan como omitidos.
const { query } = require('./_lib/db');
const { send, readJson, handler, httpError } = require('./_lib/http');
const { requireUser } = require('./_lib/auth');
const { asegurarHistorial } = require('./_lib/migraciones');

const MAX_FILAS = 2000;
const MAX_BORRAR = 500;
const LIMITE_BUSQUEDA = 50;

// Un artículo "está en un conteo" si tiene líneas o historial en cualquier conteo
const EN_CONTEO = `(EXISTS (SELECT 1 FROM conteo_lineas l WHERE l.articulo_id = a.id)
                  OR EXISTS (SELECT 1 FROM conteo_historial h WHERE h.articulo_id = a.id))`;

function idOpcional(valor, mensaje) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number.parseInt(valor, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(valor).trim()) throw httpError(400, mensaje);
  return n;
}

// Si un operador guarda un conteo de ese artículo justo mientras se borra, la base rechaza el borrado
function errorReferencia(e) {
  if (e && (e.code === '23503' || /foreign key|violates/i.test(String(e.message)))) {
    return httpError(409, 'Un artículo empezó a contarse mientras se borraba. Intente de nuevo.');
  }
  return e;
}

const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const texto = (v, max) => String(v ?? '').trim().slice(0, max);

function numero(v, { min, max }) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 10000) / 10000;
}

module.exports = handler(async (req, res) => {
  const admin = await requireUser(req, ['admin']);
  const params = new URL(req.url, 'http://x').searchParams;
  const action = params.get('action');
  if (['buscar', 'borrar', 'borrar-todos'].includes(action)) await asegurarHistorial();

  if (action === 'buscar' && req.method === 'GET') {
    const sucursal = idOpcional(params.get('sucursal'), 'Sucursal inválida');
    // Se escapan los comodines de LIKE para que % y _ se busquen como texto
    const q = String(params.get('q') || '').trim().slice(0, 60).replace(/[\\%_]/g, '\\$&');
    const filtro = `($1::int IS NULL OR a.sucursal_id = $1)
       AND ($2 = '' OR a.codigo ILIKE '%' || $2 || '%' OR a.alterno ILIKE '%' || $2 || '%' OR a.nombre ILIKE '%' || $2 || '%')`;
    const [{ total }] = await query(`SELECT count(*)::int AS total FROM articulos a WHERE ${filtro}`, [sucursal, q]);
    const articulos = await query(
      `SELECT a.id, a.codigo, a.alterno, a.nombre, s.nombre AS sucursal,
              a.costo::float8 AS costo, a.existencia::float8 AS existencia, ${EN_CONTEO} AS en_conteo
         FROM articulos a JOIN sucursales s ON s.id = a.sucursal_id
        WHERE ${filtro}
        ORDER BY s.nombre, a.codigo LIMIT ${LIMITE_BUSQUEDA}`, [sucursal, q]);
    return send(res, 200, { total, articulos });
  }

  if (action === 'listado' && req.method === 'GET') {
    const sucursal = idOpcional(params.get('sucursal'), 'Sucursal inválida');
    const articulos = await query(
      `SELECT a.codigo, a.alterno, a.nombre, s.nombre AS sucursal, a.costo::float8 AS costo, a.existencia::float8 AS existencia
         FROM articulos a JOIN sucursales s ON s.id = a.sucursal_id
        WHERE ($1::int IS NULL OR a.sucursal_id = $1) ORDER BY s.nombre, a.codigo`, [sucursal]);
    return send(res, 200, { articulos });
  }

  if (action === 'borrar' && req.method === 'POST') {
    const { ids } = await readJson(req);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BORRAR) throw httpError(400, 'Lista de artículos inválida');
    const lista = [...new Set(ids.map(v => idOpcional(v, 'Artículo inválido')))];
    try {
      const [r] = await query(
        `WITH objetivo AS (SELECT a.id, ${EN_CONTEO} AS en_conteo FROM articulos a WHERE a.id = ANY($1::bigint[])),
              d AS (DELETE FROM articulos WHERE id IN (SELECT id FROM objetivo WHERE NOT en_conteo) RETURNING id)
         SELECT (SELECT count(*) FROM d)::int AS borrados,
                (SELECT count(*) FROM objetivo WHERE en_conteo)::int AS en_conteo,
                (SELECT count(*) FROM objetivo)::int AS encontrados`, [lista]);
      if (!r.encontrados) throw httpError(404, 'El artículo no existe o ya fue borrado');
      console.log(`${r.borrados} artículo(s) borrados por ${admin.usuario}`);
      return send(res, 200, { borrados: r.borrados, omitidos: r.en_conteo });
    } catch (e) { throw errorReferencia(e); }
  }

  if (action === 'borrar-todos' && req.method === 'POST') {
    const b = await readJson(req);
    if (b.confirmar !== 'BORRAR') throw httpError(400, 'Falta la confirmación');
    const sucursal = idOpcional(b.sucursal_id, 'Sucursal inválida');
    try {
      const [r] = await query(
        `WITH objetivo AS (SELECT a.id, ${EN_CONTEO} AS en_conteo FROM articulos a WHERE ($1::int IS NULL OR a.sucursal_id = $1)),
              d AS (DELETE FROM articulos WHERE id IN (SELECT id FROM objetivo WHERE NOT en_conteo) RETURNING id)
         SELECT (SELECT count(*) FROM d)::int AS borrados,
                (SELECT count(*) FROM objetivo WHERE en_conteo)::int AS omitidos`, [sucursal]);
      console.log(`${r.borrados} artículos borrados por ${admin.usuario} (sucursal ${sucursal ?? 'todas'}), ${r.omitidos} omitidos`);
      return send(res, 200, r);
    } catch (e) { throw errorReferencia(e); }
  }

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
