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
  '/api/usuarios': require('../api/usuarios.js'), '/api/inventario': require('../api/inventario.js'), '/api/conteo': require('../api/conteo.js'), '/api/exportar': require('../api/exportar.js')
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
await pg1.type('#count-expression', '3+4');
await pg1.click('#modal-save-btn');
T('guardar cierra el modal', await esperar(() => !document.getElementById('counting-modal').classList.contains('active')));
T('contados = 1', (await texto('#stat-counted')) === '1');
const guardado = (await pg.query("SELECT sum(cantidad)::float8 s, count(*)::int n FROM conteo_lineas")).rows[0];
T('en la base quedó 7 (3+4) en 1 línea', guardado.s === 7 && guardado.n === 1, JSON.stringify(guardado));

// Recargar: el conteo abierto se retoma
await pg1.reload({ waitUntil: 'networkidle0' });
T('al recargar se retoma el conteo abierto', await esperar(() => document.getElementById('dashboard-view').classList.contains('active-view') && document.querySelectorAll('#items-table-body tr').length > 0));
T('...con lo ya contado (1)', (await texto('#stat-counted')) === '1');
const ls = await pg1.evaluate(() => Object.keys(localStorage).filter(k => /inventory|filename/.test(k)));
T('el navegador no guarda el inventario', ls.length === 0, ls.join());

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
await pg1.screenshot({ path: 'E:/KIRO/tools-conteo/e2e_final.png', fullPage: true });
T('sin errores de JavaScript en la consola', errores.length === 0, errores.join(' | '));
await br.close();
srv.close();
terminar();
