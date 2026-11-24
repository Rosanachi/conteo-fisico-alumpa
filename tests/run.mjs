// Pruebas de la etapa 1: esquema, setup, login, roles, bloqueo y catálogo (PostgreSQL local con PGlite)
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.AUTH_SECRET = 'x'.repeat(40);
process.env.SETUP_TOKEN = 'token-de-prueba-1234567890';

const pg = new PGlite();
globalThis.__TEST_DB__ = { query: async (t, p) => (await pg.query(t, p)).rows };

const setup = require('../api/setup.js');
const auth = require('../api/auth.js');
const catalogo = require('../api/catalogo.js');
const usuarios = require('../api/usuarios.js');

let fallos = 0;
const T = (nombre, ok, extra = '') => { if (!ok) fallos++; console.log(ok ? 'OK  ' : 'FAIL', nombre, ok ? '' : extra); };

async function call(fn, { method = 'GET', url = '/', headers = {}, body, cookie } = {}) {
  const req = { method, url, headers: { host: 'localhost', ...headers, ...(cookie ? { cookie } : {}) }, body };
  const out = { status: 0, headers: {}, text: '' };
  const res = {
    statusCode: 200,
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    end(t) { out.status = this.statusCode; out.text = t || ''; }
  };
  await fn(req, res);
  try { out.json = JSON.parse(out.text); } catch { out.json = null; }
  return out;
}
const cookieDe = r => String(r.headers['set-cookie'] || '').split(';')[0];
const SETUP = { 'x-setup-token': process.env.SETUP_TOKEN };

// --- Setup ---
let r = await call(setup, { method: 'POST', body: { usuario: 'admin', password: 'Clave12345' } });
T('setup sin token -> 403', r.status === 403);
r = await call(setup, { method: 'POST', headers: SETUP, body: { usuario: 'admin', nombre: 'Administrador', password: 'corta' } });
T('setup con contraseña corta -> 400', r.status === 400, JSON.stringify(r.json));
r = await call(setup, { method: 'POST', headers: SETUP, body: { usuario: 'admin', nombre: 'Administrador', password: 'Clave12345' } });
T('setup crea esquema y admin', r.status === 200 && r.json.adminCreado === true && r.json.sucursales === 4, JSON.stringify(r.json));
const ubic = r.json.ubicaciones;
r = await call(setup, { method: 'POST', headers: SETUP, body: { usuario: 'otro', password: 'Clave12345' } });
T('setup repetido es idempotente (no crea otro admin ni duplica ubicaciones)',
  r.status === 200 && r.json.adminCreado === false && r.json.ubicaciones === ubic, JSON.stringify(r.json));

// Conteo de ubicaciones por sucursal según el documento
const cuenta = async n => (await pg.query('SELECT count(*)::int c FROM ubicaciones u JOIN sucursales s ON s.id=u.sucursal_id WHERE s.nombre=$1', [n])).rows[0].c;
T('Capital: 20 racks + 3 pisos + 2 ferretería + 6 bodegas = 31', (await cuenta('Capital')) === 31, await cuenta('Capital'));
T('David: 10 racks + mezanine + 2 pisos + 7 bodegas = 20', (await cuenta('David')) === 20, await cuenta('David'));
T('Chitré: 16 racks + mezanine + 7 bodegas = 24', (await cuenta('Chitré')) === 24, await cuenta('Chitré'));
T('Santiago: 12 racks + mezanine + 2 pisos + 7 bodegas = 22', (await cuenta('Santiago')) === 22, await cuenta('Santiago'));

// --- Login ---
r = await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: 'admin', password: 'mala' } });
T('login con clave incorrecta -> 401 genérico', r.status === 401 && r.json.error === 'Usuario o contraseña incorrectos');
r = await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: 'noexiste', password: 'x' } });
T('login usuario inexistente -> mismo mensaje', r.status === 401 && r.json.error === 'Usuario o contraseña incorrectos');
r = await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: 'ADMIN ', password: 'Clave12345' } });
const adminCookie = cookieDe(r);
T('login admin correcto (ignora mayúsculas/espacios)', r.status === 200 && r.json.usuario.rol === 'admin' && adminCookie.startsWith('cf_session='));
T('cookie HttpOnly + SameSite=Strict', /HttpOnly/.test(r.headers['set-cookie']) && /SameSite=Strict/.test(r.headers['set-cookie']));
T('respuesta no expone hash', !/pass_hash|\$2[aby]\$/.test(r.text));
r = await call(auth, { method: 'POST', url: '/api/auth?action=login', headers: { 'x-forwarded-proto': 'https' }, body: { usuario: 'admin', password: 'Clave12345' } });
T('cookie Secure bajo https', /Secure/.test(r.headers['set-cookie']));

r = await call(auth, { url: '/api/auth?action=me', cookie: adminCookie });
T('me con sesión', r.status === 200 && r.json.usuario.usuario === 'admin');
r = await call(auth, { url: '/api/auth?action=me' });
T('me sin sesión -> 401', r.status === 401);
r = await call(auth, { url: '/api/auth?action=me', cookie: 'cf_session=basura' });
T('me con token falso -> 401', r.status === 401);
r = await call(auth, { method: 'POST', url: '/api/auth?action=login', headers: { origin: 'https://malo.com' }, body: { usuario: 'admin', password: 'Clave12345' } });
T('origen distinto -> 403', r.status === 403);

// --- Usuarios y roles ---
r = await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminCookie,
  body: { usuario: 'op.capital', nombre: 'Operador Capital', password: 'Operador123', rol: 'operador', sucursal_id: 1 } });
T('admin crea operador con sucursal fija', r.status === 201, JSON.stringify(r.json));
r = await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminCookie,
  body: { usuario: 'op.capital', nombre: 'X', password: 'Operador123', rol: 'operador' } });
T('usuario duplicado -> 409', r.status === 409, JSON.stringify(r.json));
r = await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminCookie,
  body: { usuario: 'op.libre', nombre: 'Operador Libre', password: 'Operador123', rol: 'operador' } });
T('admin crea operador sin sucursal fija', r.status === 201);
r = await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: adminCookie,
  body: { usuario: 'rolmalo', nombre: 'X', password: 'Operador123', rol: 'root' } });
T('rol inválido -> 400', r.status === 400);

r = await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: 'op.capital', password: 'Operador123' } });
const opCookie = cookieDe(r);
T('operador inicia sesión', r.status === 200 && r.json.usuario.rol === 'operador' && r.json.usuario.sucursal === 'Capital', JSON.stringify(r.json));
r = await call(usuarios, { url: '/api/usuarios', cookie: opCookie });
T('operador NO puede listar usuarios -> 403', r.status === 403);
r = await call(usuarios, { method: 'POST', url: '/api/usuarios?action=crear', cookie: opCookie, body: { usuario: 'hack', nombre: 'h', password: 'Operador123', rol: 'admin' } });
T('operador NO puede crear admin -> 403', r.status === 403);
r = await call(usuarios, { url: '/api/usuarios', cookie: adminCookie });
T('admin lista usuarios sin hash', r.status === 200 && r.json.usuarios.length === 3 && !/pass_hash/.test(r.text));

// --- Catálogo ---
r = await call(catalogo, { url: '/api/catalogo', cookie: opCookie });
T('operador con sucursal fija ve solo Capital', r.status === 200 && r.json.sucursales.length === 1 && r.json.sucursales[0].nombre === 'Capital');
r = await call(catalogo, { url: '/api/catalogo?sucursal=2', cookie: opCookie });
T('operador no accede a otra sucursal -> 403', r.status === 403);
r = await call(catalogo, { url: '/api/catalogo?sucursal=1', cookie: opCookie });
T('operador ve ubicaciones de su sucursal', r.status === 200 && r.json.ubicaciones.length === 31);
r = await call(catalogo, { url: '/api/catalogo', cookie: adminCookie });
T('admin ve las 4 sucursales', r.json.sucursales.length === 4);
r = await call(catalogo, { url: '/api/catalogo?sucursal=abc', cookie: adminCookie });
T('sucursal no numérica -> 400', r.status === 400);
r = await call(catalogo, { url: '/api/catalogo' });
T('catálogo sin sesión -> 401', r.status === 401);

// --- Desactivar usuario corta el acceso en la siguiente petición ---
const opId = (await pg.query("SELECT id FROM usuarios WHERE usuario='op.capital'")).rows[0].id;
r = await call(usuarios, { method: 'POST', url: '/api/usuarios?action=actualizar', cookie: adminCookie, body: { id: opId, activo: false } });
T('admin desactiva operador', r.status === 200);
r = await call(auth, { url: '/api/auth?action=me', cookie: opCookie });
T('operador desactivado pierde la sesión al instante', r.status === 401);
const adminId = (await pg.query("SELECT id FROM usuarios WHERE usuario='admin'")).rows[0].id;
r = await call(usuarios, { method: 'POST', url: '/api/usuarios?action=actualizar', cookie: adminCookie, body: { id: adminId, activo: false } });
T('admin no puede desactivarse a sí mismo', r.status === 400);

// --- Bloqueo por intentos fallidos ---
await call(usuarios, { method: 'POST', url: '/api/usuarios?action=actualizar', cookie: adminCookie, body: { id: opId, activo: true } });
for (let i = 0; i < 5; i++) await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: 'op.capital', password: 'incorrecta' } });
r = await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: 'op.capital', password: 'Operador123' } });
T('tras 5 intentos fallidos la cuenta se bloquea (aun con clave correcta) -> 429', r.status === 429, JSON.stringify(r.json));
r = await call(usuarios, { method: 'POST', url: '/api/usuarios?action=actualizar', cookie: adminCookie, body: { id: opId, password: 'NuevaClave123' } });
r = await call(auth, { method: 'POST', url: '/api/auth?action=login', body: { usuario: 'op.capital', password: 'NuevaClave123' } });
T('admin restablece la clave y desbloquea', r.status === 200);

// --- Logout ---
r = await call(auth, { method: 'POST', url: '/api/auth?action=logout' });
T('logout borra la cookie', /Max-Age=0/.test(r.headers['set-cookie']));

console.log(fallos ? `\n${fallos} prueba(s) fallaron` : '\nTodas las pruebas pasaron');
process.exit(fallos ? 1 : 0);
