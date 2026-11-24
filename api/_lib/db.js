// Acceso a PostgreSQL (Neon). La cadena de conexión viene SOLO de la variable de entorno DATABASE_URL.
// Las pruebas locales inyectan un adaptador en globalThis.__TEST_DB__ (PGlite).
let sql;

async function query(text, params = []) {
  if (globalThis.__TEST_DB__) return globalThis.__TEST_DB__.query(text, params);
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Falta la variable de entorno DATABASE_URL');
    const { neon } = require('@neondatabase/serverless');
    sql = neon(url);
  }
  return sql.query(text, params);   // devuelve un arreglo de filas
}

module.exports = { query };
