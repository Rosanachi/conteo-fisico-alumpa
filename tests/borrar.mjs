// Pruebas del borrado de conteos (solo administrador)
import { pg, require, T, terminar, call, cookieDe } from './helpers.mjs';

const setup = require('../api/setup.js');
const auth = require('../api/auth.js');
const usuarios = require('../api/usuarios.js');
const inventario = require('../api/inventario.js');
const conteo = require('../api/conteo.js');
const borrar = require('../api/borrar-conteos.js');

await call(setup, { method: 'POST', headers: { 'x-setup-token': process.env.SETUP_TOKEN }, body: { usuario: 'admin', nombre: 'Admin', password: 'Clave12345' } });
const login = async (u, p) => cookieDe(await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: u, password: p } }));
const adminC = await login('admin', 'Clave12345');
for (const [u, s] of [['ana', 1], ['beto', 1], ['cris', 2]]) {
  await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminC, body: { usuario: u, nombre: u, password: 'Operador123', rol: 'operador', sucursal_id: s } });
}
const c = { ana: await login('ana', 'Operador123'), beto: await login('beto', 'Operador123'), cris: await login('cris', 'Operador123') };
await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: adminC, body: { filas: [
  { sucursal: 'Capital', codigo: 'A1', existencia: 1 }, { sucursal: 'David', codigo: 'D1', existencia: 1 }] } });
const ub = async (s, n) => (await pg.query('SELECT id FROM ubicaciones WHERE sucursal_id=$1 AND nombre=$2', [s, n])).rows[0].id;
const art = async cod => (await pg.query('SELECT id FROM articulos WHERE codigo=$1', [cod])).rows[0].id;
async function contar(cookie, ubicacion, codigo, cantidad, finalizar = true) {
  await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie, body: { ubicacion_id: ubicacion } });
  await call(conteo, { method: 'POST', url: '/api/conteo?action=guardar', cookie, body: { articulo_id: await art(codigo), parciales: [{ cantidad, detalle: '' }] } });
  if (finalizar) await call(conteo, { method: 'POST', url: '/api/conteo?action=finalizar', cookie });
}
const r1 = await ub(1, 'Rack Vertical 1 - Sección A'), r2 = await ub(1, 'Rack Vertical 2 - Sección A'), p1 = await ub(1, 'Piso 1'), d1 = await ub(2, 'Piso 1');
await contar(c.ana, r1, 'A1', 5);          // Capital finalizado
await contar(c.ana, r2, 'A1', 6);          // Capital finalizado
await contar(c.cris, d1, 'D1', 2);         // David finalizado
await contar(c.beto, p1, 'A1', 9, false);  // Capital EN CURSO
const n = async (where = 'true') => (await pg.query(`SELECT count(*)::int c FROM conteos WHERE ${where}`)).rows[0].c;
const lineas = async () => (await pg.query('SELECT count(*)::int c FROM conteo_lineas')).rows[0].c;
const B = (cookie, action, body) => call(borrar, { method: 'POST', url: '/api/borrar-conteos?action=' + action, cookie, body });

// Permisos
let r = await B(c.ana, 'uno', { conteo_id: 1 });
T('operador NO puede borrar un conteo -> 403', r.status === 403 && (await n()) === 4);
r = await B(c.ana, 'todos', { confirmar: 'BORRAR' });
T('operador NO puede borrar todos -> 403', r.status === 403 && (await n()) === 4);
r = await B(null, 'uno', { conteo_id: 1 });
T('sin sesión -> 401', r.status === 401);
r = await call(borrar, { method: 'GET', url: '/api/borrar-conteos?action=uno', cookie: adminC });
T('GET no borra -> 405', r.status === 405 && (await n()) === 4);
r = await call(borrar, { method: 'POST', url: '/api/borrar-conteos?action=todos', cookie: adminC, headers: { origin: 'https://malo.com' }, body: { confirmar: 'BORRAR' } });
T('petición desde otro sitio -> 403', r.status === 403 && (await n()) === 4);

// Borrar uno
const primero = (await pg.query("SELECT id FROM conteos WHERE ubicacion_id=$1", [r1])).rows[0].id;
r = await B(adminC, 'uno', { conteo_id: primero });
T('admin borra un conteo finalizado (con sus líneas)', r.status === 200 && r.json.conteos === 1 && r.json.lineas === 1 && (await n()) === 3 && (await lineas()) === 3, JSON.stringify(r.json));
r = await B(adminC, 'uno', { conteo_id: primero });
T('borrarlo de nuevo -> 404', r.status === 404);
r = await B(adminC, 'uno', { conteo_id: '1 OR 1=1' });
T('id con inyección -> 400 y no borra nada', r.status === 400 && (await n()) === 3);
r = await B(adminC, 'uno', {});
T('sin id -> 400', r.status === 400);

// Borrar todos: requiere confirmación, respeta sucursal y no toca los en curso
r = await B(adminC, 'todos', {});
T('borrar todos sin confirmación -> 400', r.status === 400 && (await n()) === 3);
r = await B(adminC, 'todos', { confirmar: 'borrar' });
T('la confirmación distingue mayúsculas -> 400', r.status === 400 && (await n()) === 3);
r = await B(adminC, 'todos', { confirmar: 'BORRAR', sucursal_id: 2 });
T('borrar todos de David: borra solo el de David', r.status === 200 && r.json.conteos === 1 && (await n("sucursal_id=2")) === 0 && (await n("sucursal_id=1")) === 2, JSON.stringify(r.json));
r = await B(adminC, 'todos', { confirmar: 'BORRAR' });
T('borrar todos: borra el finalizado restante y deja el EN CURSO de Beto', r.status === 200 && r.json.conteos === 1 && (await n()) === 1 && (await n("estado='abierto'")) === 1, JSON.stringify(r.json));
r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: c.beto });
T('Beto sigue contando con sus datos', r.status === 200 && r.json.lineas.length === 1);
r = await B(adminC, 'todos', { confirmar: 'BORRAR' });
T('sin nada que borrar -> 0', r.status === 200 && r.json.conteos === 0);

// Borrar un conteo EN CURSO (individual): el operador queda sin conteo abierto
const abierto = (await pg.query("SELECT id FROM conteos WHERE estado='abierto'")).rows[0].id;
r = await B(adminC, 'uno', { conteo_id: abierto });
T('admin puede borrar un conteo en curso', r.status === 200 && (await n()) === 0 && (await lineas()) === 0);
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=guardar', cookie: c.beto, body: { articulo_id: await art('A1'), parciales: [{ cantidad: 1, detalle: '' }] } });
T('el operador recibe 409 al intentar guardar', r.status === 409 && /No tiene un conteo abierto/.test(r.json.error));
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: c.beto, body: { ubicacion_id: p1 } });
T('y puede iniciar un conteo nuevo', r.status === 201);
T('el inventario y los usuarios no se tocan', (await pg.query('SELECT count(*)::int c FROM articulos')).rows[0].c === 2 && (await pg.query('SELECT count(*)::int c FROM usuarios')).rows[0].c === 4);

terminar();
