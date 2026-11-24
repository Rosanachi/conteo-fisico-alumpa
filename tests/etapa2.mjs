// Pruebas de la etapa 2: carga de inventario, conteo por ubicación, concurrencia y finalización
import { pg, require, T, terminar, call, cookieDe } from './helpers.mjs';

const setup = require('../api/setup.js');
const auth = require('../api/auth.js');
const usuarios = require('../api/usuarios.js');
const inventario = require('../api/inventario.js');
const conteo = require('../api/conteo.js');

const SETUP = { 'x-setup-token': process.env.SETUP_TOKEN };
await call(setup, { method: 'POST', headers: SETUP, body: { usuario: 'admin', nombre: 'Admin', password: 'Clave12345' } });
const login = async (usuario, password) => cookieDe(await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario, password } }));
const adminC = await login('admin', 'Clave12345');
const mk = (usuario, sucursal_id) => call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminC,
  body: { usuario, nombre: usuario, password: 'Operador123', rol: 'operador', sucursal_id } });
await mk('ana', 1); await mk('beto', 1); await mk('cris', 2);
const anaC = await login('ana', 'Operador123'), betoC = await login('beto', 'Operador123'), crisC = await login('cris', 'Operador123');
const ubic = async (suc, like) => (await pg.query('SELECT id FROM ubicaciones WHERE sucursal_id=$1 AND nombre ILIKE $2 ORDER BY orden LIMIT 1', [suc, like])).rows[0].id;
const rack1 = await ubic(1, 'Rack Vertical 1 - Sección A'), rack2 = await ubic(1, 'Rack Vertical 2 - Sección A'), piso1 = await ubic(1, 'Piso 1');

// --- Carga de inventario ---
const filas = [
  { sucursal: 'Capital', codigo: 'A1', alterno: '0735FA61', nombre: 'Angulo', costo: 1.5, existencia: 10 },
  { sucursal: 'capital', codigo: 'A2', alterno: '0830BL', nombre: 'Tubo', costo: '2,25', existencia: '5' },
  { sucursal: 'David', codigo: 'A1', alterno: '0735FA61', nombre: 'Angulo David', costo: 1.5, existencia: 7 },
  { sucursal: 'Chitre', codigo: 'A3', alterno: '', nombre: 'Chitré (sin acento)', costo: 0, existencia: 1 },
  { sucursal: 'Panamá', codigo: 'X', nombre: 'sucursal inexistente' },
  { sucursal: 'Capital', codigo: '', nombre: 'sin código' },
  { sucursal: 'Capital', codigo: 'NEG', costo: -3, existencia: 1 },
  { sucursal: 'Capital', codigo: 'A1', alterno: '0735FA61', nombre: 'Angulo (duplicado, gana este)', costo: 1.5, existencia: 12 }
];
let r = await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: anaC, body: { filas } });
T('operador NO puede cargar inventario -> 403', r.status === 403);
r = await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: adminC, body: { filas: [] } });
T('carga vacía -> 400', r.status === 400);
r = await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: adminC, body: { filas } });
T('carga: 4 insertados, 3 rechazadas', r.status === 200 && r.json.insertados === 4 && r.json.rechazadas === 3, JSON.stringify(r.json));
T('rechazos explican el motivo', r.json.errores.some(e => /desconocida/.test(e.error)) && r.json.errores.some(e => /vac/.test(e.error)) && r.json.errores.some(e => /Costo/.test(e.error)));
const a1 = (await pg.query("SELECT existencia::float8 e, nombre FROM articulos WHERE codigo='A1' AND sucursal_id=1")).rows[0];
T('duplicado dentro del archivo: gana la última fila', a1.e === 12 && /duplicado/.test(a1.nombre), JSON.stringify(a1));
T('costo con coma decimal se interpreta', (await pg.query("SELECT costo::float8 c FROM articulos WHERE codigo='A2'")).rows[0].c === 2.25);
r = await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: adminC, body: { filas: [{ ...filas[0], existencia: 99 }] } });
T('recarga actualiza sin duplicar', r.json.insertados === 0 && r.json.actualizados === 1);
T('el mismo código vive por separado en cada sucursal', (await pg.query("SELECT count(*)::int c FROM articulos WHERE codigo='A1'")).rows[0].c === 2);
r = await call(inventario, { url: '/api/inventario?action=resumen', cookie: adminC });
T('resumen por sucursal', r.status === 200 && r.json.sucursales.find(s => s.nombre === 'Capital').articulos === 2);

// --- Conteo ---
r = await call(conteo, { url: '/api/conteo?action=actual' });
T('conteo sin sesión -> 401', r.status === 401);
r = await call(conteo, { url: '/api/conteo?action=actual', cookie: anaC });
T('sin conteo abierto -> null', r.status === 200 && r.json.conteo === null);
r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
T('artículos sin conteo abierto -> 409', r.status === 409);
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: crisC, body: { ubicacion_id: rack1 } });
T('operador de David no puede abrir ubicación de Capital -> 403', r.status === 403);
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: anaC, body: { ubicacion_id: 99999 } });
T('ubicación inexistente -> 404', r.status === 404);
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: anaC, body: { ubicacion_id: 'abc' } });
T('ubicación no numérica -> 400', r.status === 400);
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: anaC, body: { ubicacion_id: rack1 } });
T('ana abre conteo en Rack 1-A', r.status === 201 && r.json.conteo.ubicacion === 'Rack Vertical 1 - Sección A' && r.json.conteo.sucursal === 'Capital', JSON.stringify(r.json));
const conteoAna = r.json.conteo.id;
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: anaC, body: { ubicacion_id: rack1 } });
T('repetir la misma ubicación reanuda (no duplica)', r.status === 200 && r.json.conteo.id === conteoAna);
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: anaC, body: { ubicacion_id: rack2 } });
T('bloqueo por ubicación: no puede abrir otra mientras tenga una abierta -> 409', r.status === 409 && /Finalícelo/.test(r.json.error), JSON.stringify(r.json));
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: betoC, body: { ubicacion_id: rack2 } });
T('beto abre conteo en Rack 2-A a la vez', r.status === 201);

r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
T('ana ve solo artículos de Capital (2)', r.status === 200 && r.json.articulos.length === 2 && r.json.articulos.every(a => typeof a.existencia === 'number'), JSON.stringify(r.json).slice(0, 200));
const art = Object.fromEntries(r.json.articulos.map(a => [a.codigo, a.id]));
const davidArt = (await pg.query("SELECT id FROM articulos WHERE sucursal_id=2 AND codigo='A1'")).rows[0].id;

// --- Guardar (con concurrencia entre ana y beto) ---
const g = (cookie, articulo_id, parciales) => call(conteo, { method: 'POST', url: '/api/conteo?action=guardar', cookie, body: { articulo_id, parciales } });
const [g1, g2] = await Promise.all([
  g(anaC, art.A1, [{ cantidad: 5, detalle: 'caja 1' }, { cantidad: 2.5, detalle: '' }]),
  g(betoC, art.A1, [{ cantidad: 3, detalle: 'Directo' }])
]);
T('dos operadores guardan el mismo artículo a la vez sin conflicto', g1.status === 200 && g2.status === 200 && g1.json.lineas.length === 2 && g2.json.lineas.length === 1);
const suma = async id => (await pg.query('SELECT COALESCE(sum(cantidad),0)::float8 s FROM conteo_lineas WHERE conteo_id=$1 AND articulo_id=$2', [id, art.A1])).rows[0].s;
const conteoBeto = (await pg.query("SELECT id FROM conteos WHERE usuario_id=(SELECT id FROM usuarios WHERE usuario='beto')")).rows[0].id;
T('cada conteo conserva lo suyo (ana 7.5, beto 3)', (await suma(conteoAna)) === 7.5 && (await suma(conteoBeto)) === 3);
r = await g(anaC, art.A1, [{ cantidad: 4, detalle: 'corregido' }]);
T('guardar de nuevo reemplaza lo anterior (no suma)', r.status === 200 && (await suma(conteoAna)) === 4 && (await suma(conteoBeto)) === 3);
r = await g(anaC, art.A1, [{ cantidad: 0, detalle: 'Directo' }]);
T('contar en 0 queda registrado (distinto de pendiente)', r.status === 200 && (await suma(conteoAna)) === 0 &&
  (await pg.query('SELECT count(*)::int c FROM conteo_lineas WHERE conteo_id=$1', [conteoAna])).rows[0].c === 1);
r = await g(anaC, art.A1, []);
T('lista vacía deja el artículo pendiente', r.status === 200 && (await pg.query('SELECT count(*)::int c FROM conteo_lineas WHERE conteo_id=$1', [conteoAna])).rows[0].c === 0);
r = await g(anaC, art.A1, [{ cantidad: -1, detalle: '' }]);
T('cantidad negativa -> 400', r.status === 400);
r = await g(anaC, art.A1, [{ cantidad: 'abc', detalle: '' }]);
T('cantidad no numérica -> 400', r.status === 400);
r = await g(anaC, art.A1, 'no-es-lista');
T('parciales inválidos -> 400', r.status === 400);
r = await g(anaC, davidArt, [{ cantidad: 1, detalle: '' }]);
T('artículo de otra sucursal -> 404', r.status === 404);
r = await g(anaC, art.A1, [{ cantidad: 2.345, detalle: 'x'.repeat(300) }]);
const l = (await pg.query('SELECT cantidad::float8 c, length(detalle) n FROM conteo_lineas WHERE conteo_id=$1', [conteoAna])).rows[0];
T('cantidad se redondea a 2 decimales y el detalle se recorta', l.c === 2.35 && l.n === 100, JSON.stringify(l));
await g(anaC, art.A2, [{ cantidad: 6, detalle: '' }]);

r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
T('al reabrir la lista vienen las líneas guardadas', r.json.lineas.length === 2);

// --- Finalizar ---
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=finalizar', cookie: anaC });
T('ana finaliza: 2 artículos, 8.35 unidades', r.status === 200 && r.json.articulos_contados === 2 && r.json.unidades === 8.35, JSON.stringify(r.json));
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=finalizar', cookie: anaC });
T('finalizar dos veces -> 409', r.status === 409);
r = await g(anaC, art.A1, [{ cantidad: 1, detalle: '' }]);
T('no se puede guardar en un conteo finalizado -> 409', r.status === 409);
r = await call(conteo, { url: '/api/conteo?action=actual', cookie: anaC });
T('tras finalizar no hay conteo abierto (pantalla limpia)', r.json.conteo === null);
T('los datos del conteo finalizado siguen en la base', (await pg.query('SELECT count(*)::int c FROM conteo_lineas WHERE conteo_id=$1', [conteoAna])).rows[0].c === 2);
r = await call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: anaC, body: { ubicacion_id: piso1 } });
T('ana puede abrir otra ubicación después de finalizar', r.status === 201);
r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: anaC });
T('el nuevo conteo empieza vacío', r.json.lineas.length === 0);
r = await call(conteo, { url: '/api/conteo?action=articulos', cookie: betoC });
T('el conteo de beto sigue abierto con sus datos', r.status === 200 && r.json.lineas.length === 1);

terminar();
