// Pruebas del historial de guardados dentro del conteo actual
import { pg, require, T, terminar, call, cookieDe } from './helpers.mjs';

const setup = require('../api/setup.js');
const auth = require('../api/auth.js');
const usuarios = require('../api/usuarios.js');
const inventario = require('../api/inventario.js');
const conteo = require('../api/conteo.js');
const borrar = require('../api/borrar-conteos.js');

await call(setup, { method: 'POST', headers: { 'x-setup-token': process.env.SETUP_TOKEN }, body: { usuario: 'admin', nombre: 'Admin', password: 'Clave12345' } });
// Simula la base de producción: creada antes de existir el historial
await pg.query('DROP TABLE conteo_historial');
const existe = async () => (await pg.query("SELECT to_regclass('conteo_historial') IS NOT NULL AS e")).rows[0].e;
T('la base empieza sin la tabla de historial (como en Neon hoy)', !(await existe()));

const login = async (u, p) => cookieDe(await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: u, password: p } }));
const adminC = await login('admin', 'Clave12345');
for (const u of ['ana', 'beto']) {
  await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminC, body: { usuario: u, nombre: u, password: 'Operador123', rol: 'operador', sucursal_id: 1 } });
}
const anaC = await login('ana', 'Operador123'), betoC = await login('beto', 'Operador123');
await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: adminC, body: { filas: [
  { sucursal: 'Capital', codigo: 'A1', existencia: 1 }, { sucursal: 'Capital', codigo: 'A2', existencia: 1 }] } });
const art = async cod => (await pg.query('SELECT id FROM articulos WHERE codigo=$1', [cod])).rows[0].id;
const ub = async n => (await pg.query("SELECT id FROM ubicaciones WHERE sucursal_id=1 AND nombre=$1", [n])).rows[0].id;
const iniciar = (c, u) => call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: c, body: { ubicacion_id: u } });
const guardar = (c, a, cantidades) => call(conteo, { method: 'POST', url: '/api/conteo?action=guardar', cookie: c,
  body: { articulo_id: a, parciales: cantidades.map(q => ({ cantidad: q, detalle: 'Directo' })) } });

const rack1 = await ub('Rack Vertical 1 - Sección A');
await iniciar(anaC, rack1);
let r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
T('al abrir el conteo la tabla de historial se crea sola', r.status === 200 && await existe() && Array.isArray(r.json.historial) && r.json.historial.length === 0, JSON.stringify(r.json?.error));

const a1 = await art('A1'), a2 = await art('A2');
r = await guardar(anaC, a1, [7]);
T('primer guardado: historial con 1 registro (7)', r.status === 200 && r.json.historial.length === 1 && r.json.historial[0].cantidad === 7 && !!r.json.historial[0].creado, JSON.stringify(r.json));
r = await guardar(anaC, a1, [10]);
T('segundo guardado: 2 registros en orden (7, 10)', r.json.historial.map(h => h.cantidad).join() === '7,10');
T('...y lo contado vigente es 10 (no se suma el historial)', (await pg.query('SELECT sum(cantidad)::float8 s FROM conteo_lineas')).rows[0].s === 10);
r = await guardar(anaC, a1, []);
T('dejarlo pendiente queda registrado como vacío', r.json.historial.length === 3 && r.json.historial[2].cantidad === null);
r = await guardar(anaC, a1, [0]);
T('contar en 0 se distingue de pendiente', r.json.historial[3].cantidad === 0);
await guardar(anaC, a2, [3]);

r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
const deA1 = r.json.historial.filter(h => h.articulo_id === a1);
T('al reabrir, el historial viene por artículo (A1: 4, A2: 1)', deA1.length === 4 && r.json.historial.filter(h => h.articulo_id === a2).length === 1, JSON.stringify(r.json.historial));

// Otros usuarios y otros conteos no se mezclan
await iniciar(betoC, await ub('Piso 1'));
await guardar(betoC, a1, [99]);
r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
T('el historial de Ana no incluye lo de Beto', r.json.historial.length === 5 && !r.json.historial.some(h => h.cantidad === 99));
r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: betoC });
T('Beto solo ve lo suyo', r.json.historial.length === 1 && r.json.historial[0].cantidad === 99);

// Tras finalizar, el conteo nuevo empieza sin historial (aunque sea la misma ubicación)
await call(conteo, { method: 'POST', url: '/api/conteo?action=finalizar', cookie: anaC });
await iniciar(anaC, rack1);
r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
T('nuevo conteo en la misma ubicación: historial vacío', r.json.historial.length === 0);
r = await guardar(anaC, a1, [5]);
T('...y empieza su propio historial', r.json.historial.length === 1 && r.json.historial[0].cantidad === 5);

// Un guardado rechazado no deja rastro
r = await guardar(anaC, a1, [-1]);
T('cantidad inválida no se registra en el historial', r.status === 400 && (await pg.query('SELECT count(*)::int c FROM conteo_historial')).rows[0].c === 7);

// Borrar conteos también borra su historial
const B = (action, body) => call(borrar, { method: 'POST', url: '/api/borrar-conteos?action=' + action, cookie: adminC, body });
const finalizado = (await pg.query("SELECT id FROM conteos WHERE estado='finalizado'")).rows[0].id;
r = await B('uno', { conteo_id: finalizado });
T('borrar un conteo con historial funciona y borra su historial', r.status === 200 &&
  (await pg.query('SELECT count(*)::int c FROM conteo_historial WHERE conteo_id=$1', [finalizado])).rows[0].c === 0, JSON.stringify(r.json));
await call(conteo, { method: 'POST', url: '/api/conteo?action=finalizar', cookie: anaC });
await call(conteo, { method: 'POST', url: '/api/conteo?action=finalizar', cookie: betoC });
r = await B('todos', { confirmar: 'BORRAR' });
T('borrar todos los finalizados también borra su historial', r.status === 200 && r.json.conteos === 2 &&
  (await pg.query('SELECT count(*)::int c FROM conteo_historial')).rows[0].c === 0, JSON.stringify(r.json));

terminar();
