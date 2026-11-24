// Sucursales y ubicaciones iniciales (según el documento de mejora).
const BODEGAS = [
  'Bodega de Vidrios', 'Bodega de Láminas Plásticas', 'Bodega de Ventanas',
  'Bodega Láminas Aluminio', 'Bodega de Cauchos', 'Bodega de Jambas'
];

// "Rack Vertical 3 - Sección A"
function racks(tipo, cantidad) {
  const out = [];
  for (let i = 1; i <= cantidad; i++) {
    for (const sec of ['A', 'B']) out.push(`Rack ${tipo} ${i} - Sección ${sec}`);
  }
  return out;
}

const SEED = {
  'Capital': [
    ...racks('Vertical', 5), ...racks('Horizontal', 5),
    'Piso 1', 'Piso 2', 'Piso 3',
    'Ferretería - Bodega 1 Planta Baja', 'Ferretería - Bodega 2 Mezanine',
    ...BODEGAS
  ],
  'David': [
    ...racks('Vertical', 5),
    'Mezanine Aluminio', 'Piso 1', 'Piso 2',
    'Bodega Ferretería', ...BODEGAS
  ],
  'Chitré': [
    ...racks('Vertical', 4), ...racks('Horizontal', 4),
    'Mezanine Aluminio',
    'Bodega Ferretería', ...BODEGAS
  ],
  'Santiago': [
    ...racks('Horizontal', 6),
    'Mezanine Aluminio', 'Piso 1', 'Piso 2',
    'Bodega Ferretería', ...BODEGAS
  ]
};

module.exports = { SEED };
