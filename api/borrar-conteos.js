// Borrado de conteos (solo administrador). El borrado es definitivo.
// POST /api/borrar-conteos?action=uno    { conteo_id }            -> borra un conteo (finalizado o en curso)
// POST /api/borrar-conteos?action=todos  { sucursal_id?, confirmar: 'BORRAR' }
//      -> borra todos los conteos FINALIZADOS (de una sucursal o de todas). Los conteos en curso no se tocan.
const { query } = require('./_lib/db');
const { send, readJson, handler, httpError } = require('./_lib/http');
const { requireUser } = require('./_lib/auth');
const { asegurarHistorial } = require('./_lib/migraciones');

function idOpcional(valor, mensaje) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number.parseInt(valor, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(valor).trim()) throw httpError(400, mensaje);
  return n;
}

module.exports = handler(async (req, res) => {
  const admin = await requireUser(req, ['admin']);
  if (req.method !== 'POST') throw httpError(405, 'Método no permitido');
  await asegurarHistorial();
  const action = new URL(req.url, 'http://x').searchParams.get('action');
  const b = await readJson(req);

  if (action === 'uno') {
    const id = idOpcional(b.conteo_id, 'Conteo inválido');
    if (!id) throw httpError(400, 'Conteo inválido');
    // Una sola sentencia: borra las líneas y el conteo juntos
    const [r] = await query(
      `WITH c AS (DELETE FROM conteo_lineas WHERE conteo_id = $1 RETURNING 1),
            h AS (DELETE FROM conteo_historial WHERE conteo_id = $1 RETURNING 1),
            d AS (DELETE FROM conteos WHERE id = $1 RETURNING id)
       SELECT (SELECT count(*) FROM d)::int AS conteos, (SELECT count(*) FROM c)::int AS lineas`, [id]);
    if (!r.conteos) throw httpError(404, 'El conteo no existe o ya fue borrado');
    console.log(`Conteo ${id} borrado por ${admin.usuario}`);
    return send(res, 200, { conteos: r.conteos, lineas: r.lineas });
  }

  if (action === 'todos') {
    if (b.confirmar !== 'BORRAR') throw httpError(400, 'Falta la confirmación');
    const sucursal = idOpcional(b.sucursal_id, 'Sucursal inválida');
    const [r] = await query(
      `WITH objetivo AS (
         SELECT id FROM conteos WHERE estado = 'finalizado' AND ($1::int IS NULL OR sucursal_id = $1)
       ), c AS (DELETE FROM conteo_lineas WHERE conteo_id IN (SELECT id FROM objetivo) RETURNING 1),
          h AS (DELETE FROM conteo_historial WHERE conteo_id IN (SELECT id FROM objetivo) RETURNING 1),
          d AS (DELETE FROM conteos WHERE id IN (SELECT id FROM objetivo) RETURNING id)
       SELECT (SELECT count(*) FROM d)::int AS conteos, (SELECT count(*) FROM c)::int AS lineas`, [sucursal]);
    console.log(`${r.conteos} conteos finalizados borrados por ${admin.usuario} (sucursal ${sucursal ?? 'todas'})`);
    return send(res, 200, { conteos: r.conteos, lineas: r.lineas });
  }

  throw httpError(404, 'Acción no encontrada');
});
