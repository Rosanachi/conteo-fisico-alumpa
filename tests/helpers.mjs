// Utilidades compartidas por las pruebas: base PGlite + invocación de manejadores sin servidor
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'module';
export const require = createRequire(import.meta.url);

process.env.AUTH_SECRET = 'x'.repeat(40);
process.env.SETUP_TOKEN = 'token-de-prueba-1234567890';

export const pg = new PGlite();
globalThis.__TEST_DB__ = { query: async (t, p) => (await pg.query(t, p)).rows };

let fallos = 0;
export const T = (nombre, ok, extra = '') => { if (!ok) fallos++; console.log(ok ? 'OK  ' : 'FAIL', nombre, ok ? '' : extra); };
export const terminar = () => { console.log(fallos ? `\n${fallos} prueba(s) fallaron` : '\nTodas las pruebas pasaron'); process.exit(fallos ? 1 : 0); };

export async function call(fn, { method = 'GET', url = '/', headers = {}, body, cookie } = {}) {
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
export const cookieDe = r => String(r.headers['set-cookie'] || '').split(';')[0];
