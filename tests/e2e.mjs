// Prueba de extremo a extremo en un navegador real (Edge headless):
// servidor local con las mismas funciones /api y PostgreSQL local (PGlite).
// Requiere puppeteer-core y xlsx instalados en E:\KIRO\tools-conteo.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { pg, require, T, terminar } from './helpers.mjs';

const tools = require('module').createRequire('E:/KIRO/tools-conteo/package.json');
const puppeteer = tools('puppeteer-core');
const XLSX = tools('xlsx');

// Si algo se cuelga, la prueba falla en vez de quedarse esperando
setTimeout(() => { console.log('FAIL tiempo máximo excedido'); process.exit(1); }, 180000).unref();

const ROOT = path.resolve(import.meta.dirname, '..');
const CSP = JSON.parse(fs.readFileSync(ROOT + '/vercel.json', 'utf8')).headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
const handlers = {
  '/api/setup': require('../api/setup.js'), '/api/auth': require('../api/auth.js'), '/api/catalogo': require('../api/catalogo.js'),
  '/api/usuarios': require('../api/usuarios.js'), '/api/inventario': require('../api/inventario.js'), '/api/conteo': require('../api/conteo.js'), '/api/exportar': require('../api/exportar.js'),
  '/api/borrar-conteos': require('../api/borrar-conteos.js')
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (handlers[u.pathname]) return handlers[u.pathname](req, res);
  let f = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const full = path.join(ROOT, f);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory() || /node_modules|datos|\.git/.test(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
  fs.createReadStream(full).pipe(res);
});
await new Promise(r => srv.listen(0, r));
const BASE = 'http://localhost:' + srv.address().port;

// Excel consolidado de prueba: los artículos reales repartidos en Capital y David
const real = XLSX.utils.sheet_to_json(XLSX.readFile(ROOT + '/datos/articulosaluminio.xlsx').Sheets.Hoja1, { defval: '' });
const filas = [];
real.slice(0, 1500).forEach(r => {
  filas.push({ Código: r.Codigo, Alterno: String(r.alterno).trim(), Nombre: String(r.descripcion).trim(), Sucursal: 'Capital', Costo: 10, Existencia: 5 });
  if (filas.length % 3 === 0) filas.push({ Código: r.Codigo, Alterno: String(r.alterno).trim(), Nombre: String(r.descripcion).trim(), Sucursal: 'David', Costo: 10, Existencia: 2 });
});
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), 'H');
const excel = path.join(process.env.TEMP, 'inventario_prueba.xlsx');
XLSX.writeFile(wb, excel);

// Administrador inicial
await new Promise(r => setTimeout(r, 200));
const setupRes = await fetch(BASE + '/api/setup', { method: 'POST', headers: { 'x-setup-token': process.env.SETUP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: 'admin', nombre: 'Administrador', password: 'Clave12345' }) });
T('setup por HTTP', setupRes.status === 200);

const br = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new' });
const pg1 = await br.newPage();
await pg1.setViewport({ width: 1300, height: 900 });
const errores = [];
pg1.on('pageerror', e => errores.push('PAGEERROR ' + e.message));
pg1.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errores.push('CONSOLE ' + m.text()); });
const dialogos = [];
pg1.on('dialog', async d => { dialogos.push(d.message()); await d.accept(); });

const vis = async sel => pg1.$eval(sel, e => !e.hidden && e.offsetParent !== null).catch(() => false);
const texto = async sel => pg1.$eval(sel, e => e.textContent.trim()).catch(() => null);
const esperar = (fn, ms = 8000) => pg1.waitForFunction(fn, { timeout: ms }).then(() => true).catch(() => false);
const login = async (u, p) => { await pg1.$eval('#login-user', e => e.value = ''); await pg1.type('#login-user', u); await pg1.type('#login-pass', p); await pg1.click('#login-form button[type=submit]'); };

await pg1.goto(BASE + '/', { waitUntil: 'networkidle0' });
T('sin sesión se muestra el login', await vis('#login-view') && !(await vis('#dashboard-view')));

await login('admin', 'incorrecta');
T('clave incorrecta muestra el error', await esperar(() => !document.getElementById('login-error').hidden) && /incorrectos/.test(await texto('#login-error')));

await pg1.$eval('#login-pass', e => e.value = '');
await login('admin', 'Clave12345');
T('admin entra al panel de administración', await esperar(() => document.getElementById('admin-view').classList.contains('active-view')));
T('el encabezado muestra al usuario y el botón Salir', await vis('#user-chip') && /Administrador/.test(await texto('#user-name')));
T('el botón Descargar Excel ya no existe', (await pg1.$('#download-results-btn')) === null);

// Carga del Excel por el administrador
await (await pg1.$('#inv-file')).uploadFile(excel);
T('carga de Excel termina y muestra el resultado', await esperar(() => !document.getElementById('inv-result').hidden, 30000), dialogos.join('|'));
const res = await texto('#inv-result');
const nDavid = filas.filter(f => f.Sucursal === 'David').length;
T(`resultado: ${filas.length} nuevos (1500 Capital + ${nDavid} David)`, new RegExp('Nuevos: ' + filas.length + ' ').test(res) && /Rechazados: 0/.test(res), res);
await esperar(() => /1500\s*Capital/.test(document.getElementById('inv-resumen').textContent));
const resumen = await texto('#inv-resumen');
T('resumen por sucursal actualizado', /1500\s*Capital/.test(resumen) && new RegExp(nDavid + '\\s*David').test(resumen), resumen);

// Crear un operador
await pg1.type('#user-usuario', 'ana');
await pg1.type('#user-nombre', 'Ana Pérez');
await pg1.type('#user-pass', 'Operador123');
await pg1.select('#user-rol', 'operador');
await pg1.select('#user-sucursal', String((await pg.query("SELECT id FROM sucursales WHERE nombre='Capital'")).rows[0].id));
await pg1.click('#user-form button[type=submit]');
T('se crea el usuario operador', await esperar(() => /Usuario creado/.test(document.getElementById('user-msg').textContent)));
T('aparece en la lista', await esperar(() => /ana/.test(document.getElementById('user-list').textContent)));

// Salir y entrar como operador
await pg1.click('#logout-btn');
T('Salir vuelve al login', await esperar(() => document.getElementById('login-view').classList.contains('active-view')));
await login('ana', 'Operador123');
T('operador ve selección de sucursal/ubicación', await esperar(() => document.getElementById('select-view').classList.contains('active-view')));
await esperar(() => document.getElementById('select-ubicacion').options.length > 1);
const sucursales = await pg1.$$eval('#select-sucursal option', o => o.map(x => x.textContent));
T('operador con sucursal fija solo ve Capital', sucursales.filter(s => !/Seleccione/.test(s)).join() === 'Capital', sucursales.join());
T('"Comenzar" está deshabilitado hasta elegir ubicación', await pg1.$eval('#select-start-btn', b => b.disabled));
const ubicaciones = await pg1.$$eval('#select-ubicacion option', o => o.length - 1);
T('se listan las 31 ubicaciones de Capital', ubicaciones === 31, String(ubicaciones));
await pg1.select('#select-ubicacion', String((await pg.query("SELECT id FROM ubicaciones WHERE nombre='Rack Vertical 1 - Sección A' AND sucursal_id=1")).rows[0].id));
await pg1.click('#select-start-btn');
T('abre la pantalla de conteo', await esperar(() => document.getElementById('dashboard-view').classList.contains('active-view') && document.querySelectorAll('#items-table-body tr').length > 0));
T('encabezado muestra sucursal › ubicación', /Capital › Rack Vertical 1 - Sección A/.test(await texto('#loaded-file-name')));
T('total de artículos = 1500 (solo Capital)', (await texto('#stat-total')) === '1500', await texto('#stat-total'));
const cabeceras = await pg1.$$eval('.items-table th', h => h.map(x => x.textContent.trim()));
T('el operador no ve Diferencia ni Bodega', !cabeceras.includes('Diferencia') && !cabeceras.includes('Bodega'), cabeceras.join());
T('no hay botones de descarga', (await pg1.$('#share-whatsapp-btn')) === null && (await pg1.$('#load-new-file-btn')) === null);
await new Promise(r => setTimeout(r, 1500));
const imgs = await pg1.$$eval('img.thumb-img', i => i.filter(x => x.complete && x.naturalWidth > 0).length);
T('se siguen mostrando las imágenes del catálogo', imgs > 0, String(imgs));

// Contar un artículo
await pg1.type('#search-input', 'PAANG00830BLS19');
await pg1.keyboard.press('Enter');
T('Enter con código exacto abre el modal', await esperar(() => document.getElementById('counting-modal').classList.contains('active')));
T('el modal no muestra diferencia', (await pg1.$('#summary-difference')) === null);
T('historial: un artículo sin contar dice que aún no se ha contado', await vis('#history-empty') && /Todavía no se ha contado/.test(await texto('#history-empty')) &&
  (await pg1.$$eval('#history-list li', l => l.length)) === 0);
await pg1.type('#count-expression', '3+4');
await pg1.click('#modal-save-btn');
T('guardar cierra el modal', await esperar(() => !document.getElementById('counting-modal').classList.contains('active')));
T('contados = 1', (await texto('#stat-counted')) === '1');
const guardado = (await pg.query("SELECT sum(cantidad)::float8 s, count(*)::int n FROM conteo_lineas")).rows[0];
T('en la base quedó 7 (3+4) en 1 línea', guardado.s === 7 && guardado.n === 1, JSON.stringify(guardado));

// Modal simplificado: sin "Acumular conteos parciales"; al reabrir muestra lo contado para corregir o sumar
T('el modal ya no tiene cantidad/ubicación/Agregar', (await pg1.$('#partial-qty')) === null && (await pg1.$('#add-partial-btn')) === null && (await pg1.$('.accumulative-section')) === null);
const abrirModal = async () => {
  await pg1.click('#items-table-body tr');
  await esperar(() => document.getElementById('counting-modal').classList.contains('active'));
};
const guardarModal = async () => {
  await pg1.click('#modal-save-btn');
  return esperar(() => !document.getElementById('counting-modal').classList.contains('active'), 3000);
};
const totalBase = async () => (await pg.query('SELECT sum(cantidad)::float8 s, count(*)::int n FROM conteo_lineas')).rows[0];

// Al editar, el campo sale en blanco y muestra lo ya guardado
await abrirModal();
T('editar: el campo de cantidad sale en blanco', (await pg1.$eval('#count-expression', e => e.value)) === '');
T('editar: muestra lo ya guardado (7)', await vis('#count-base') && /Ya guardado en este conteo: 7/.test(await texto('#count-base')), await texto('#count-base'));
T('editar: el total muestra lo guardado mientras no se escriba nada', (await texto('#summary-total-counted')) === '7');

// Sumar: 7 + 3 = 10
await pg1.type('#count-expression', '3');
T('sumar: la vista previa muestra 7 + 3 = 10', /7 \+ 3 = 10/.test(await texto('#expression-preview')) && (await texto('#summary-total-counted')) === '10', await texto('#expression-preview'));
await guardarModal();
let tb = await totalBase();
T('sumar: se guarda 10 (en una sola línea)', tb.s === 10 && tb.n === 1, JSON.stringify(tb));

// Campo vacío: cierra sin cambios ni registro en el historial
await abrirModal();
await guardarModal();
T('campo vacío: cierra sin cambiar lo guardado ni registrar en el historial', (await totalBase()).s === 10 &&
  (await pg.query('SELECT count(*)::int c FROM conteo_historial')).rows[0].c === 2);

// Restar más de lo guardado: avisa y no guarda
await abrirModal();
await pg1.type('#count-expression', '-20');
T('restar de más: la vista previa avisa que no puede quedar negativo', /no puede quedar negativo/.test(await texto('#expression-preview')), await texto('#expression-preview'));
const avisos = dialogos.length;
await pg1.click('#modal-save-btn');
await new Promise(r => setTimeout(r, 400));
T('restar de más: no se guarda y la ventana sigue abierta', dialogos.length === avisos + 1 && /no puede quedar negativo/.test(dialogos.at(-1)) &&
  (await totalBase()).s === 10 && await pg1.$eval('#counting-modal', m => m.classList.contains('active')), dialogos.at(-1));

// Borrar todo lo contado: restar lo guardado (10 - 10 = 0)
await pg1.$eval('#count-expression', e => { e.value = ''; });
await pg1.type('#count-expression', '-10');
await guardarModal();
tb = await totalBase();
T('restar todo: -10 deja el artículo en 0', tb.s === 0 && tb.n === 1, JSON.stringify(tb));

// Botones -1/+5 trabajan sobre la cantidad a sumar y no dejan el total en negativo
await abrirModal();
await pg1.click('.btn-adjust[data-val="-1"]');
T('botón -1 con 0 guardado no baja de 0', (await pg1.$eval('#count-expression', e => e.value)) === '');
await pg1.click('.btn-adjust[data-val="5"]');
await pg1.click('.btn-adjust[data-val="1"]');
await pg1.click('.btn-adjust[data-val="1"]');
T('botones +5 +1 +1 suman 7', (await pg1.$eval('#count-expression', e => e.value)) === '7' && (await texto('#summary-total-counted')) === '7');
await guardarModal();
T('se restablece a 7 para el resto de la prueba', (await totalBase()).s === 7);

// Historial en la ventana: 4 guardados (7, 10, 0, 7); el vacío y el rechazado no cuentan
await pg1.click('#items-table-body tr');
await esperar(() => document.getElementById('counting-modal').classList.contains('active'));
const hist = await pg1.$$eval('#history-list li', l => l.map(x => x.querySelector('.history-qty').textContent));
T('historial: muestra la cantidad colocada cada vez (+7, +3, -10, +7), la más reciente arriba', hist.join(',') === '+7,-10,+3,+7', hist.join(','));
T('historial: no muestra los totales ni la marca vigente', !hist.includes('10') && !hist.includes('0') && (await pg1.$('.history-tag')) === null);
T('historial: las restas se destacan en rojo', await pg1.$$eval('#history-list .history-neg', e => e.map(x => x.textContent).join()) === '-10');
T('historial: el título indica el número de veces', /Veces contado en este conteo: 4/.test(await texto('#history-title')), await texto('#history-title'));
await pg1.screenshot({ path: 'E:/KIRO/tools-conteo/modal_historial.png' });
T('historial: cada vez muestra la hora', await pg1.$$eval('#history-list .history-time', t => t.every(x => /^\d{1,2}:\d{2}/.test(x.textContent.trim()))));
await pg1.click('#modal-cancel-btn');
await esperar(() => !document.getElementById('counting-modal').classList.contains('active'));
await pg1.reload({ waitUntil: 'networkidle0' });
await esperar(() => document.querySelectorAll('#items-table-body tr').length > 0);
await pg1.type('#search-input', 'PAANG00830BLS19');
await pg1.keyboard.press('Enter');
await esperar(() => document.getElementById('counting-modal').classList.contains('active'));
T('historial: se conserva al recargar la página', (await pg1.$$eval('#history-list li', l => l.length)) === 4);
await pg1.click('#modal-cancel-btn');
await esperar(() => !document.getElementById('counting-modal').classList.contains('active'));
await pg1.$eval('#search-input', e => { e.value = ''; e.dispatchEvent(new Event('input')); });

// Fotos por código: un artículo del listado "sin aluminio" (no tiene imagen en el catálogo PDF)
const fotosIdx = JSON.parse(fs.readFileSync(ROOT + '/fotos/index.json', 'utf8')).items;
await pg.query("INSERT INTO articulos (sucursal_id, codigo, alterno, nombre, costo, existencia) SELECT id, 'EMCAU00006NEG00', 'FVC0006', 'EMPAQ.SOPORTE 25 X 1.6 MM', 1, 1 FROM sucursales WHERE nombre='Capital'");

// Recargar: el conteo abierto se retoma
await pg1.reload({ waitUntil: 'networkidle0' });
T('al recargar se retoma el conteo abierto', await esperar(() => document.getElementById('dashboard-view').classList.contains('active-view') && document.querySelectorAll('#items-table-body tr').length > 0));
T('...con lo ya contado (1)', (await texto('#stat-counted')) === '1');
const ls = await pg1.evaluate(() => Object.keys(localStorage).filter(k => /inventory|filename/.test(k)));
T('el navegador no guarda el inventario', ls.length === 0, ls.join());

await pg1.type('#search-input', 'EMCAU00006NEG00');
await new Promise(r => setTimeout(r, 400));
const fotoOk = await esperar(() => { const i = document.querySelector('#items-table-body tr img.thumb-img'); return i && i.complete && i.naturalWidth > 0; }, 6000);
const fotoSrc = await pg1.$eval('#items-table-body tr img.thumb-img', i => i.getAttribute('src')).catch(() => null);
T('fotos por código: el artículo muestra su foto del listado', fotoOk && fotoSrc === 'fotos/' + fotosIdx['EMCAU00006NEG00'], String(fotoSrc));
await pg1.keyboard.press('Enter');
await esperar(() => document.getElementById('counting-modal').classList.contains('active'));
T('fotos por código: la foto también aparece en la ventana de conteo', await esperar(() => { const i = document.getElementById('modal-article-img'); return !i.hidden && i.complete && i.naturalWidth > 0; }, 6000));
await pg1.click('#modal-cancel-btn');
await esperar(() => !document.getElementById('counting-modal').classList.contains('active'));
await pg1.$eval('#search-input', e => { e.value = ''; e.dispatchEvent(new Event('input')); });

// Finalizar
await pg1.click('#finish-count-btn');
T('"Finalizado Conteo" abre la confirmación', await esperar(() => document.getElementById('finish-modal').classList.contains('active')));
T('la confirmación indica el número de artículos', /1 artículo/.test(await texto('#finish-text')), await texto('#finish-text'));
await pg1.click('#finish-cancel-btn');
T('"Seguir contando" cierra sin finalizar', !(await pg1.$eval('#finish-modal', m => m.classList.contains('active'))) && (await pg.query("SELECT count(*)::int c FROM conteos WHERE estado='abierto'")).rows[0].c === 1);
await pg1.click('#finish-count-btn');
await pg1.click('#finish-confirm-btn');
T('al confirmar vuelve a la selección con aviso', await esperar(() => document.getElementById('select-view').classList.contains('active-view') && !document.getElementById('select-notice').hidden));
T('el aviso confirma lo finalizado', /Conteo finalizado en Capital › Rack Vertical 1/.test(await texto('#select-notice')), await texto('#select-notice'));
const limpia = await pg1.evaluate(() => ({ filas: document.querySelectorAll('#items-table-body tr').length, tarjetas: document.querySelectorAll('#items-cards-grid .item-card').length }));
T('la pantalla de conteo quedó limpia', limpia.filas === 0 && limpia.tarjetas === 0, JSON.stringify(limpia));
T('en la base el conteo quedó finalizado y con datos', (await pg.query("SELECT count(*)::int c FROM conteos WHERE estado='finalizado'")).rows[0].c === 1 &&
  (await pg.query('SELECT count(*)::int c FROM conteo_lineas')).rows[0].c === 1);

// Operador nuevo no puede entrar al panel de administración por la API
const r403 = await pg1.evaluate(async () => (await fetch('/api/usuarios')).status);
T('un operador recibe 403 en /api/usuarios', r403 === 403, String(r403));

// Sesión vencida: el servidor desactiva al usuario mientras tiene la pantalla abierta
await pg.query("UPDATE usuarios SET activo=false WHERE usuario='ana'");
await pg1.select('#select-ubicacion', '').catch(() => {});
const r401 = await pg1.evaluate(async () => (await fetch('/api/catalogo')).status);
T('usuario desactivado recibe 401', r401 === 401);


// ---- El administrador descarga los conteos finalizados ----
await pg1.reload({ waitUntil: 'networkidle0' });
await login('admin', 'Clave12345');
T('admin ve la lista de conteos finalizados', await esperar(() => document.querySelectorAll('#cnt-list tbody tr').length === 1));
const fila = await texto('#cnt-list tbody tr');
if (!fila) console.log('DEBUG cnt-list:', await texto('#cnt-list'), '| abiertos:', await texto('#cnt-abiertos'), '| errores:', errores.join(' | '));
T('la fila muestra sucursal, ubicación y usuario', /Capital/.test(fila) && /Rack Vertical 1 - Sección A/.test(fila) && /Ana Pérez/.test(fila), fila);

const dir = path.join(process.env.TEMP, 'dl_' + Date.now());
fs.mkdirSync(dir, { recursive: true });
const cdp = await pg1.createCDPSession();
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
const esperarArchivo = async (prefijo) => {
  for (let i = 0; i < 40; i++) {
    const f = fs.readdirSync(dir).find(x => x.startsWith(prefijo) && x.endsWith('.xlsx'));
    if (f) return path.join(dir, f);
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
};
await pg1.click('#cnt-list tbody tr button.btn-success');
const archivo = await esperarArchivo('conteo_');
T('se descarga el Excel del conteo', !!archivo, fs.readdirSync(dir).join());
if (archivo) {
  const wbx = XLSX.readFile(archivo);
  const hoja = wbx.Sheets[wbx.SheetNames[0]];
  const cab = XLSX.utils.sheet_to_json(hoja, { header: 1 })[0];
  T('columnas exactas y sin Diferencias', cab.join('|') === 'Código|Alterno|Nombre|Sucursal|Costo|Existencia|Contado|Ubicación Asignada|Usuario|Fecha de Conteo', cab.join('|'));
  const datos = XLSX.utils.sheet_to_json(hoja);
  T('el Excel trae el artículo contado (7 unidades)', datos.length === 1 && datos[0]['Código'] === 'PAANG00830BLS19' && datos[0]['Contado'] === 7, JSON.stringify(datos));
  T('con ubicación, usuario y fecha', datos[0]['Ubicación Asignada'] === 'Rack Vertical 1 - Sección A' && datos[0]['Usuario'] === 'Ana Pérez' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(datos[0]['Fecha de Conteo']), JSON.stringify(datos[0]));
}
await pg1.click('#cnt-all-btn');
const consolidado = await esperarArchivo('consolidado_');
T('se descarga el consolidado', !!consolidado);

await pg1.evaluate(() => {
  window.__shared = null;
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', { value: async d => { window.__shared = { n: d.files[0].name, size: d.files[0].size, type: d.files[0].type }; }, configurable: true });
});
await pg1.click('#cnt-list tbody tr button.btn-secondary');
await esperar(() => window.__shared !== null);
const compartido = await pg1.evaluate(() => window.__shared);
T('WhatsApp: abre el menú de compartir con el Excel adjunto', compartido && /^conteo_Capital_/.test(compartido.n) && compartido.size > 1000 && /spreadsheetml/.test(compartido.type), JSON.stringify(compartido));

// ---- Borrar conteos (administrador) ----
// Diálogos: confirmaciones se aceptan; en el prompt se escribe BORRAR
pg1.removeAllListeners('dialog');
pg1.on('dialog', async d => { dialogos.push(d.message()); await (d.type() === 'prompt' ? d.accept('BORRAR') : d.accept()); });
// Datos extra: un segundo conteo finalizado (Capital) y uno en curso (David), creados directo en la base
const sid = async n => (await pg.query('SELECT id FROM sucursales WHERE nombre=$1', [n])).rows[0].id;
const capital = await sid('Capital'), david = await sid('David');
const adminId = (await pg.query("SELECT id FROM usuarios WHERE usuario='admin'")).rows[0].id;
const ubic2 = (await pg.query("SELECT id FROM ubicaciones WHERE sucursal_id=$1 AND nombre='Piso 1'", [capital])).rows[0].id;
const ubicD = (await pg.query("SELECT id FROM ubicaciones WHERE sucursal_id=$1 AND nombre='Piso 1'", [david])).rows[0].id;
const artC = (await pg.query('SELECT id FROM articulos WHERE sucursal_id=$1 LIMIT 1', [capital])).rows[0].id;
const c2 = (await pg.query("INSERT INTO conteos (sucursal_id, ubicacion_id, usuario_id, estado, finalizado_en) VALUES ($1,$2,$3,'finalizado',now()) RETURNING id", [capital, ubic2, adminId])).rows[0].id;
await pg.query('INSERT INTO conteo_lineas (conteo_id, articulo_id, cantidad) VALUES ($1,$2,4)', [c2, artC]);
await pg.query("INSERT INTO conteos (sucursal_id, ubicacion_id, usuario_id) VALUES ($1,$2,$3)", [david, ubicD, adminId]);
await pg1.click('#cnt-refresh-btn');
T('la lista muestra 2 finalizados y 1 en curso con botón Borrar', await esperar(() => document.querySelectorAll('#cnt-list tbody tr').length === 2 && document.querySelectorAll('#cnt-abiertos .open-list button').length === 1));

// Borrar uno (finalizado): descarga respaldo y desaparece de la lista
const filaPiso = await pg1.$$eval('#cnt-list tbody tr', trs => trs.findIndex(t => /Piso 1/.test(t.textContent)));
await (await pg1.$$('#cnt-list tbody tr'))[filaPiso].$eval('button.btn-danger-outline', b => b.click());
T('borrar uno: pide confirmación', await esperar(() => true) && /Borrar el conteo finalizado/.test(dialogos.at(-1) || ''), dialogos.at(-1));
T('borrar uno: se descarga el respaldo', !!(await esperarArchivo('respaldo_conteo_Capital_Piso-1')), fs.readdirSync(dir).join());
T('borrar uno: desaparece de la lista y de la base', await esperar(() => document.querySelectorAll('#cnt-list tbody tr').length === 1) &&
  (await pg.query('SELECT count(*)::int c FROM conteos WHERE id=$1', [c2])).rows[0].c === 0);

// Borrar todos los finalizados: confirma, pide escribir BORRAR, descarga consolidado de respaldo y deja el en curso
await pg1.click('#cnt-delete-all-btn');
T('borrar todos: se descarga el consolidado de respaldo', !!(await esperarArchivo('respaldo_consolidado_todas')), fs.readdirSync(dir).join());
T('borrar todos: la lista de finalizados queda vacía', await esperar(() => /Aún no hay conteos finalizados/.test(document.getElementById('cnt-list').textContent)));
T('borrar todos: pidió escribir BORRAR y confirmó el resultado', dialogos.some(m => /Escriba BORRAR/.test(m)) && /Se borraron 1 conteo/.test(dialogos.at(-1)), dialogos.slice(-3).join(' | '));
T('el conteo en curso NO se borró', (await pg.query("SELECT count(*)::int c FROM conteos WHERE estado='abierto'")).rows[0].c === 1 && await vis('#cnt-abiertos'));

// Borrar el conteo en curso
await pg1.click('#cnt-abiertos .open-list button');
T('borrar en curso: avisa que el operador perderá lo contado', await esperar(() => document.getElementById('cnt-abiertos').hidden) && /EN CURSO/.test(dialogos.find(m => /EN CURSO/.test(m)) || ''));
T('ya no quedan conteos en la base', (await pg.query('SELECT count(*)::int c FROM conteos')).rows[0].c === 0 && (await pg.query('SELECT count(*)::int c FROM conteo_lineas')).rows[0].c === 0);

// Texto incorrecto en el prompt: no se borra nada
pg1.removeAllListeners('dialog');
pg1.on('dialog', async d => { dialogos.push(d.message()); await (d.type() === 'prompt' ? d.accept('borrar') : d.accept()); });
const c3 = (await pg.query("INSERT INTO conteos (sucursal_id, ubicacion_id, usuario_id, estado, finalizado_en) VALUES ($1,$2,$3,'finalizado',now()) RETURNING id", [capital, ubic2, adminId])).rows[0].id;
await pg.query('INSERT INTO conteo_lineas (conteo_id, articulo_id, cantidad) VALUES ($1,$2,1)', [c3, artC]);
await pg1.click('#cnt-delete-all-btn');
await esperar(() => /no coincide/.test(window.__lastAlert || ''), 1500);
await new Promise(r => setTimeout(r, 800));
T('si no escribe BORRAR exacto, no se borra nada', /no coincide/.test(dialogos.at(-1) || '') && (await pg.query('SELECT count(*)::int c FROM conteos')).rows[0].c === 1, dialogos.at(-1));

// ---- Buscar y borrar artículos del inventario ----
pg1.removeAllListeners('dialog');
pg1.on('dialog', async d => { dialogos.push(d.message()); await (d.type() === 'prompt' ? d.accept('BORRAR') : d.accept()); });
const nArt = async (suc) => (await pg.query('SELECT count(*)::int c FROM articulos WHERE ($1::int IS NULL OR sucursal_id=$1)', [suc ?? null])).rows[0].c;
const buscarArt = async (texto) => {
  await pg1.$eval('#art-q', (e, v) => { e.value = v; }, texto);
  await pg1.click('#art-form button[type=submit]');
  await new Promise(r => setTimeout(r, 300));
};
await buscarArt('EMCAU00006NEG00');
T('buscar artículo: aparece en la lista', await esperar(() => /EMCAU00006NEG00/.test(document.getElementById('art-list').textContent)));
await pg1.click('#art-list tbody tr button.btn-danger-outline');
T('borrar un artículo: se borra y desaparece', await esperar(() => /borrado/.test(document.getElementById('art-msg').textContent)) &&
  (await pg.query("SELECT count(*)::int c FROM articulos WHERE codigo='EMCAU00006NEG00'")).rows[0].c === 0 && /Borrar el artículo EMCAU00006NEG00/.test(dialogos.find(m => /EMCAU00006NEG00/.test(m)) || ''));

const contadoCod = (await pg.query('SELECT a.codigo FROM articulos a WHERE a.id=$1', [artC])).rows[0].codigo;
await buscarArt(contadoCod);
await esperar(() => document.querySelectorAll('#art-list tbody tr').length > 0);
const filaContado = await pg1.$$eval('#art-list tbody tr', (trs, cod) => { const t = trs.find(x => x.cells[0].textContent === cod && x.cells[3].textContent === 'Capital'); return t ? { dis: t.querySelector('button').disabled, tag: /En conteo/.test(t.textContent) } : null; }, contadoCod);
T('un artículo que está en un conteo no se puede borrar (botón desactivado)', filaContado && filaContado.dis && filaContado.tag, JSON.stringify(filaContado));

const davidN = await nArt(david);
await pg1.select('#art-sucursal', String(david));
await new Promise(r => setTimeout(r, 300));
await pg1.click('#art-delete-all-btn');
const respaldoInv = await esperarArchivo('respaldo_inventario_David_');
T('borrar listado: descarga el respaldo de David', !!respaldoInv, fs.readdirSync(dir).join());
T('borrar listado: borra todos los artículos de David y no toca Capital', await esperar(() => true) && (await nArt(david)) === 0 && (await nArt(capital)) > 1000);
await new Promise(r => setTimeout(r, 800));
T('borrar listado: informa cuántos se borraron', dialogos.some(m => new RegExp('Se borraron ' + davidN + ' artículo').test(m)), dialogos.slice(-2).join(' | '));
if (respaldoInv) {
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(respaldoInv).Sheets.Inventario);
  T('el respaldo tiene las columnas de la plantilla y todos los artículos', rows.length === davidN &&
    Object.keys(rows[0]).join('|') === 'Código|Alterno|Nombre|Sucursal|Costo|Existencia' && rows.every(x => x.Sucursal === 'David'), Object.keys(rows[0] || {}).join('|'));
}
T('el resumen por sucursal se actualiza (David en 0)', await esperar(() => /0\s*David/.test(document.getElementById('inv-resumen').textContent)));

await pg1.screenshot({ path: 'E:/KIRO/tools-conteo/e2e_final.png', fullPage: true });
T('sin errores de JavaScript en la consola', errores.length === 0, errores.join(' | '));
await br.close();
srv.close();
terminar();
