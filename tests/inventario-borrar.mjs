// Pruebas de búsqueda y borrado de artículos del inventario (solo administrador)
import { pg, require, T, terminar, call, cookieDe } from './helpers.mjs';

const setup = require('../api/setup.js');
const auth = require('../api/auth.js');
const usuarios = require('../api/usuarios.js');
const inventario = require('../api/inventario.js');
const conteo = require('../api/conteo.js');

await call(setup, { method: 'POST', headers: { 'x-setup-token': process.env.SETUP_TOKEN }, body: { usuario: 'admin', nombre: 'Admin', password: 'Clave12345' } });
const login = async (u, p) => cookieDe(await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: u, password: p } }));
const adminC = await login('admin', 'Clave12345');
await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminC, body: { usuario: 'ana', nombre: 'Ana', password: 'Operador123', rol: 'operador', sucursal_id: 1 } });
const anaC = await login('ana', 'Operador123');

const filas = [
  { sucursal: 'Capital', codigo: 'A1', alterno: '0735FA', nombre: 'Angulo 2"', existencia: 1 },
  { sucursal: 'Capital', codigo: 'A2', alterno: '0830BL', nombre: 'Tubo 100%', existencia: 1 },
  { sucursal: 'Capital', codigo: 'A3', alterno: 'X_9', nombre: 'Canal', existencia: 1 },
  { sucursal: 'Capital', codigo: 'A4', alterno: '', nombre: 'Perfil', existencia: 1 },
  { sucursal: 'David', codigo: 'A1', alterno: '0735FA', nombre: 'Angulo David', existencia: 1 },
  { sucursal: 'David', codigo: 'D2', alterno: '', nombre: 'Tornillo', existencia: 1 }
];
await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: adminC, body: { filas } });
const id = async (suc, cod) => (await pg.query('SELECT id FROM articulos WHERE sucursal_id=$1 AND codigo=$2', [suc, cod])).rows[0]?.id;
const n = async (suc) => (await pg.query('SELECT count(*)::int c FROM articulos WHERE ($1::int IS NULL OR sucursal_id=$1)', [suc ?? null])).rows[0].c;

// Ana cuenta A1 de Capital (queda en un conteo)
await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: anaC, body: { ubicacion_id: (await pg.query("SELECT id FROM ubicaciones WHERE sucursal_id=1 ORDER BY orden LIMIT 1")).rows[0].id } });
await call(conteo, { method: 'POST', url: '/api/conteo?action=guardar', cookie: anaC, body: { articulo_id: await id(1, 'A1'), parciales: [{ cantidad: 3, detalle: '' }] } });

const G = url => call(inventario, { url: '/api/inventario?' + url, cookie: adminC });
const P = (action, body, cookie = adminC) => call(inventario, { method: 'POST', url: '/api/inventario?action=' + action, cookie, body });

// --- Permisos ---
let r = await call(inventario, { url: '/api/inventario?action=buscar', cookie: anaC });
T('operador NO puede buscar en el inventario -> 403', r.status === 403);
r = await P('borrar', { ids: [await id(1, 'A2')] }, anaC);
T('operador NO puede borrar artículos -> 403', r.status === 403 && (await n()) === 6);
r = await P('borrar-todos', { confirmar: 'BORRAR' }, anaC);
T('operador NO puede borrar el listado -> 403', r.status === 403 && (await n()) === 6);
r = await call(inventario, { method: 'POST', url: '/api/inventario?action=borrar-todos', cookie: adminC, headers: { origin: 'https://malo.com' }, body: { confirmar: 'BORRAR' } });
T('petición desde otro sitio -> 403', r.status === 403 && (await n()) === 6);

// --- Buscar ---
r = await G('action=buscar');
T('buscar sin filtro: 6 artículos', r.status === 200 && r.json.total === 6 && r.json.articulos.length === 6);
r = await G('action=buscar&sucursal=1&q=angulo');
T('buscar por nombre (sin distinguir mayúsculas) y sucursal', r.json.total === 1 && r.json.articulos[0].codigo === 'A1' && r.json.articulos[0].sucursal === 'Capital');
T('buscar marca si el artículo está en un conteo', r.json.articulos[0].en_conteo === true);
r = await G('action=buscar&q=0735');
T('buscar por alterno en todas las sucursales', r.json.total === 2);
r = await G('action=buscar&q=' + encodeURIComponent('%'));
T('el % se busca como texto, no como comodín', r.json.total === 1 && r.json.articulos[0].codigo === 'A2', JSON.stringify(r.json));
r = await G('action=buscar&q=' + encodeURIComponent('_'));
T('el _ se busca como texto, no como comodín', r.json.total === 1 && r.json.articulos[0].codigo === 'A3', JSON.stringify(r.json));
r = await G('action=buscar&sucursal=abc');
T('sucursal inválida -> 400', r.status === 400);
r = await G("action=buscar&q=" + encodeURIComponent("' OR 1=1 --"));
T('texto con inyección no devuelve nada ni falla', r.status === 200 && r.json.total === 0);

// --- Listado (respaldo) ---
r = await G('action=listado&sucursal=1');
T('listado de Capital para respaldo: 4 artículos con sus columnas', r.json.articulos.length === 4 &&
  ['codigo', 'alterno', 'nombre', 'sucursal', 'costo', 'existencia'].every(k => k in r.json.articulos[0]));

// --- Borrar uno ---
r = await P('borrar', { ids: [await id(1, 'A2')] });
T('borrar un artículo', r.status === 200 && r.json.borrados === 1 && r.json.omitidos === 0 && !(await id(1, 'A2')));
r = await P('borrar', { ids: [await id(1, 'A1')] });
T('un artículo que está en un conteo NO se borra (se informa)', r.status === 200 && r.json.borrados === 0 && r.json.omitidos === 1 && !!(await id(1, 'A1')));
r = await P('borrar', { ids: [999999] });
T('artículo inexistente -> 404', r.status === 404);
r = await P('borrar', { ids: ['1 OR 1=1'] });
T('id con inyección -> 400 y no borra nada', r.status === 400 && (await n()) === 5);
r = await P('borrar', { ids: [] });
T('lista vacía -> 400', r.status === 400);
T('borrar un artículo de Capital no toca el mismo código en David', !!(await id(2, 'A1')));

// --- Borrar todo el listado ---
r = await P('borrar-todos', {});
T('sin confirmación -> 400', r.status === 400 && (await n()) === 5);
r = await P('borrar-todos', { confirmar: 'borrar' });
T('la confirmación distingue mayúsculas -> 400', r.status === 400 && (await n()) === 5);
r = await P('borrar-todos', { confirmar: 'BORRAR', sucursal_id: 2 });
T('borrar listado de David: borra solo David', r.status === 200 && r.json.borrados === 2 && (await n(2)) === 0 && (await n(1)) === 3, JSON.stringify(r.json));
r = await P('borrar-todos', { confirmar: 'BORRAR' });
T('borrar todo: borra lo libre y deja el artículo contado', r.status === 200 && r.json.borrados === 2 && r.json.omitidos === 1 && (await n()) === 1, JSON.stringify(r.json));

// El conteo de Ana sigue intacto
r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
T('el conteo en curso sigue con su artículo y su cantidad', r.status === 200 && r.json.articulos.length === 1 && r.json.lineas.length === 1 && r.json.lineas[0].cantidad === 3);
T('usuarios, sucursales y ubicaciones no se tocan', (await pg.query('SELECT count(*)::int c FROM usuarios')).rows[0].c === 2 &&
  (await pg.query('SELECT count(*)::int c FROM ubicaciones')).rows[0].c === 97);

// Después de borrar, se puede volver a cargar el mismo listado
r = await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: adminC, body: { filas } });
T('se puede volver a subir el listado (5 nuevos, 1 actualizado)', r.status === 200 && r.json.insertados === 5 && r.json.actualizados === 1, JSON.stringify(r.json));

terminar();
