// Crea las tablas agregadas después de la instalación inicial, una sola vez por instancia del servidor.
// Las sentencias son idempotentes (CREATE ... IF NOT EXISTS), así que repetirlas no causa daño.
const { query } = require('./db');
const { HISTORIAL } = require('./schema');

let listo = null;

function asegurarHistorial() {
  if (!listo) {
    listo = (async () => {
      for (const sentencia of HISTORIAL) await query(sentencia);
    })().catch(e => {
      listo = null;   // si falló, se reintenta en la siguiente petición
      throw e;
    });
  }
  return listo;
}

module.exports = { asegurarHistorial };
