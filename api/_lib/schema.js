// Esquema PostgreSQL. Cada sentencia es idempotente (se puede ejecutar varias veces).

// Historial de cada guardado dentro de un conteo (solo se agregan filas).
// cantidad NULL = el operador dejó el artículo pendiente.
// Se agregó después de la instalación inicial: también se crea automáticamente (ver migraciones.js).
const HISTORIAL = [
  `CREATE TABLE IF NOT EXISTS conteo_historial (
     id BIGSERIAL PRIMARY KEY,
     conteo_id BIGINT NOT NULL REFERENCES conteos(id),
     articulo_id BIGINT NOT NULL REFERENCES articulos(id),
     cantidad NUMERIC(14,2),
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS conteo_historial_conteo ON conteo_historial (conteo_id, articulo_id, id)`
];

const BASE = [
  `CREATE TABLE IF NOT EXISTS sucursales (
     id SERIAL PRIMARY KEY,
     nombre TEXT NOT NULL UNIQUE
   )`,
  `CREATE TABLE IF NOT EXISTS ubicaciones (
     id SERIAL PRIMARY KEY,
     sucursal_id INT NOT NULL REFERENCES sucursales(id),
     nombre TEXT NOT NULL,
     orden INT NOT NULL DEFAULT 0,
     UNIQUE (sucursal_id, nombre)
   )`,
  `CREATE TABLE IF NOT EXISTS usuarios (
     id SERIAL PRIMARY KEY,
     usuario TEXT NOT NULL UNIQUE,
     nombre TEXT NOT NULL,
     pass_hash TEXT NOT NULL,
     rol TEXT NOT NULL CHECK (rol IN ('admin', 'operador')),
     sucursal_id INT REFERENCES sucursales(id),
     activo BOOLEAN NOT NULL DEFAULT TRUE,
     intentos_fallidos INT NOT NULL DEFAULT 0,
     bloqueado_hasta TIMESTAMPTZ,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Inventario teórico cargado por el administrador (una fila por sucursal + código)
  `CREATE TABLE IF NOT EXISTS articulos (
     id BIGSERIAL PRIMARY KEY,
     sucursal_id INT NOT NULL REFERENCES sucursales(id),
     codigo TEXT NOT NULL,
     alterno TEXT NOT NULL DEFAULT '',
     nombre TEXT NOT NULL DEFAULT '',
     costo NUMERIC(14,4) NOT NULL DEFAULT 0,
     existencia NUMERIC(14,2) NOT NULL DEFAULT 0,
     UNIQUE (sucursal_id, codigo)
   )`,
  // Un conteo = una sesión de un usuario en una ubicación
  `CREATE TABLE IF NOT EXISTS conteos (
     id BIGSERIAL PRIMARY KEY,
     sucursal_id INT NOT NULL REFERENCES sucursales(id),
     ubicacion_id INT NOT NULL REFERENCES ubicaciones(id),
     usuario_id INT NOT NULL REFERENCES usuarios(id),
     estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'finalizado')),
     creado TIMESTAMPTZ NOT NULL DEFAULT now(),
     finalizado_en TIMESTAMPTZ
   )`,
  // Un usuario solo puede tener un conteo abierto a la vez
  `CREATE UNIQUE INDEX IF NOT EXISTS conteos_un_abierto_por_usuario
     ON conteos (usuario_id) WHERE estado = 'abierto'`,
  // Solo se agregan filas (nunca se pisan): dos operadores no entran en conflicto
  `CREATE TABLE IF NOT EXISTS conteo_lineas (
     id BIGSERIAL PRIMARY KEY,
     conteo_id BIGINT NOT NULL REFERENCES conteos(id),
     articulo_id BIGINT NOT NULL REFERENCES articulos(id),
     cantidad NUMERIC(14,2) NOT NULL,
     detalle TEXT NOT NULL DEFAULT '',
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS conteo_lineas_conteo ON conteo_lineas (conteo_id, articulo_id)`,
  `CREATE INDEX IF NOT EXISTS articulos_alterno ON articulos (sucursal_id, alterno)`
];

module.exports = [...BASE, ...HISTORIAL];
module.exports.HISTORIAL = HISTORIAL;
