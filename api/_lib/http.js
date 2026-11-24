// Utilidades HTTP comunes
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;     // Vercel ya lo interpreta
  if (typeof req.body === 'string' && req.body) return JSON.parse(req.body);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 6_000_000) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// Envuelve un manejador: captura errores sin exponer detalles internos
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: status >= 500 ? 'Error interno del servidor' : e.message });
    }
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { send, readJson, handler, httpError };
