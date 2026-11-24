// Pruebas de la etapa 3: exportación de conteos finalizados (solo administrador)
import { pg, require, T, terminar, call, cookieDe } from './helpers.mjs';

const setup = require('../api/setup.js');
const auth = require('../api/auth.js');
const usuarios = require('../api/usuarios.js');
const inventario = require('../api/inventario.js');
const conteo = require('../api/conteo.js');
const exportar = require('../api/exportar.js');

await call(setup, { method: 'POST', headers: { 'x-setup-token': process.env.SETUP_TOKEN }, body: { usuario: 'admin', nombre: 'Admin', password: 'Clave12345' } });
const login = async (usuario, password) => cookieDe(await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario, password } }));
const adminC = await login('admin', 'Clave12345');
for (const [u, s] of [['ana', 1], ['beto', 1], ['cris', 2]]) {
  await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminC, body: { usuario: u, nombre: `Operador ${u}`, password: 'Operador123', rol: 'operador', sucursal_id: s } });
}
const anaC = await login('ana', 'Operador123'), betoC = await login('beto', 'Operador123'), crisC = await login('cris', 'Operador123');
await call(inventario, { method: 'POST', url: '/api/inventario?action=cargar', cookie: adminC, body: { filas: [
  { sucursal: 'Capital', codigo: 'A1', alterno: '0735FA61', nombre: 'Angulo', costo: 1.5, existencia: 10 },
  { sucursal: 'Capital', codigo: 'A2', alterno: '0830BL', nombre: 'Tubo', costo: 2, existencia: 5 },
  { sucursal: 'Capital', codigo: 'A3', alterno: '0900', nombre: 'Sin contar', costo: 3, existencia: 8 },
  { sucursal: 'David', codigo: 'D1', alterno: '1111', nombre: 'Canal', costo: 4, existencia: 3 }
] } });
const ub = async (suc, nombre) => (await pg.query('SELECT id FROM ubicaciones WHERE sucursal_id=$1 AND nombre=$2', [suc, nombre])).rows[0].id;
const art = async cod => Object.fromEntries((await pg.query('SELECT codigo, id FROM articulos')).rows.map(r => [r.codigo, r.id]))[cod];
const iniciar = (c, u) => call(conteo, { method: 'POST', url: '/api/conteo?action=iniciar', cookie: c, body: { ubicacion_id: u } });
const guardar = (c, a, p) => call(conteo, { method: 'POST', url: '/api/conteo?action=guardar', cookie: c, body: { articulo_id: a, parciales: p } });
const finalizar = c => call(conteo, { method: 'POST', url: '/api/conteo?action=finalizar', cookie: c });

// Ana cuenta en Rack 1-A: A1 = 4 + 2.5, A2 = 1 ; Beto cuenta en Rack 2-A: A1 = 3 (queda abierto)
const rack1 = await ub(1, 'Rack Vertical 1 - Sección A'), rack2 = await ub(1, 'Rack Vertical 2 - Sección A'), piso1 = await ub(1, 'Piso 1');
await iniciar(anaC, rack1);
await guardar(anaC, await art('A1'), [{ cantidad: 4, detalle: 'caja' }, { cantidad: 2.5, detalle: '' }]);
await guardar(anaC, await art('A2'), [{ cantidad: 1, detalle: 'Directo' }]);
await iniciar(betoC, rack2);
await guardar(betoC, await art('A1'), [{ cantidad: 3, detalle: 'Directo' }]);
await iniciar(crisC, await ub(2, 'Piso 1'));
await guardar(crisC, await art('D1'), [{ cantidad: 0, detalle: 'Directo' }]);

// --- Antes de finalizar nada se exporta ---
let r = await call(exportar, { url: '/api/exportar?action=filas&todos=1', cookie: adminC });
T('mientras no haya conteos finalizados, el consolidado está vacío', r.status === 200 && r.json.filas.length === 0);
const conteoAna = (await pg.query("SELECT id FROM conteos WHERE usuario_id=(SELECT id FROM usuarios WHERE usuario='ana')")).rows[0].id;
r = await call(exportar, { url: `/api/exportar?action=filas&conteo=${conteoAna}`, cookie: adminC });
T('un conteo abierto no se puede exportar -> 409', r.status === 409, JSON.stringify(r.json));
r = await call(exportar, { url: '/api/exportar?action=lista', cookie: adminC });
T('la lista muestra 3 conteos en curso y ninguno finalizado', r.json.abiertos.length === 3 && r.json.finalizados.length === 0, JSON.stringify(r.json).slice(0, 200));

// --- Permisos ---
r = await call(exportar, { url: '/api/exportar?action=lista', cookie: anaC });
T('operador NO puede ver la lista -> 403', r.status === 403);
r = await call(exportar, { url: `/api/exportar?action=filas&conteo=${conteoAna}`, cookie: anaC });
T('operador NO puede descargar ni su propio conteo -> 403', r.status === 403);
r = await call(exportar, { url: '/api/exportar?action=lista' });
T('sin sesión -> 401', r.status === 401);

// --- Finalizar y exportar ---
await finalizar(anaC);
await finalizar(crisC);
r = await call(exportar, { url: `/api/exportar?action=filas&conteo=${conteoAna}`, cookie: adminC });
T('conteo finalizado de Ana: 2 artículos contados (A3 sin contar no aparece)', r.status === 200 && r.json.filas.length === 2 && !r.json.filas.some(f => f.codigo === 'A3'), JSON.stringify(r.json));
const f1 = r.json.filas.find(f => f.codigo === 'A1');
T('A1 suma los parciales: 6.5', f1.contado === 6.5);
T('trae todas las columnas pedidas', ['codigo', 'alterno', 'nombre', 'sucursal', 'costo', 'existencia', 'contado', 'ubicacion', 'usuario', 'finalizado_en'].every(k => k in f1), Object.keys(f1).join());
T('datos correctos: Capital, Rack 1-A, Operador ana, existencia 10', f1.sucursal === 'Capital' && f1.ubicacion === 'Rack Vertical 1 - Sección A' && f1.usuario === 'Operador ana' && f1.existencia === 10 && f1.costo === 1.5 && f1.alterno === '0735FA61', JSON.stringify(f1));
T('no incluye columna de diferencias', !('diferencias' in f1) && !('diferencia' in f1));
T('la fecha viene del cierre del conteo', !!f1.finalizado_en);

r = await call(exportar, { url: '/api/exportar?action=filas&todos=1', cookie: adminC });
T('consolidado: solo finalizados (Ana 2 + Cris 1) y no el abierto de Beto', r.json.filas.length === 3 && !r.json.filas.some(f => f.usuario === 'Operador beto'), JSON.stringify(r.json.filas.map(f => [f.usuario, f.codigo])));
T('contar en 0 sí aparece (D1 = 0)', r.json.filas.find(f => f.codigo === 'D1').contado === 0);
r = await call(exportar, { url: '/api/exportar?action=filas&todos=1&sucursal=2', cookie: adminC });
T('consolidado filtrado por sucursal (David)', r.json.filas.length === 1 && r.json.filas[0].sucursal === 'David');

// Segundo conteo en la misma ubicación (segunda fase): ambos quedan separados
await iniciar(anaC, rack1);
await guardar(anaC, await art('A1'), [{ cantidad: 7, detalle: 'Directo' }]);
await finalizar(anaC);
r = await call(exportar, { url: '/api/exportar?action=filas&todos=1&sucursal=1', cookie: adminC });
const a1s = r.json.filas.filter(f => f.codigo === 'A1' && f.ubicacion === 'Rack Vertical 1 - Sección A');
T('reconteo en la misma ubicación: dos filas independientes (6.5 y 7)', a1s.length === 2 && a1s.map(x => x.contado).sort().join() === '6.5,7', JSON.stringify(a1s.map(x => x.contado)));
T('cada fila identifica su conteo (conteo_id distinto)', new Set(a1s.map(x => x.conteo_id)).size === 2);

r = await call(exportar, { url: '/api/exportar?action=lista', cookie: adminC });
T('lista: 3 finalizados y 1 en curso (Beto)', r.json.finalizados.length === 3 && r.json.abiertos.length === 1 && r.json.abiertos[0].usuario === 'Operador beto');
const li = r.json.finalizados.find(c => c.id === conteoAna);
T('lista informa artículos y unidades', li.articulos === 2 && li.unidades === 7.5, JSON.stringify(li));

// --- Validaciones ---
r = await call(exportar, { url: '/api/exportar?action=filas', cookie: adminC });
T('sin conteo ni todos -> 400', r.status === 400);
r = await call(exportar, { url: '/api/exportar?action=filas&conteo=abc', cookie: adminC });
T('conteo no numérico -> 400', r.status === 400);
r = await call(exportar, { url: '/api/exportar?action=filas&conteo=1;DROP TABLE usuarios', cookie: adminC });
T('intento de inyección -> 400', r.status === 400 && (await pg.query('SELECT count(*)::int c FROM usuarios')).rows[0].c === 4);
r = await call(exportar, { url: '/api/exportar?action=filas&conteo=99999', cookie: adminC });
T('conteo inexistente -> 404', r.status === 404);
r = await call(exportar, { url: '/api/exportar?action=lista&sucursal=x', cookie: adminC });
T('sucursal inválida -> 400', r.status === 400);

terminar();
