// Panel del administrador: carga de inventario (Excel) y gestión de usuarios
const ADMIN = { sucursales: [], initialized: false };
const XLSX_SRC = 'lib/xlsx.full.min.js';
const CHUNK = 1000;

// Nombres de columna aceptados (sin acentos, en minúsculas)
const ADMIN_COLUMNS = {
    codigo: ['codigo', 'code'],
    alterno: ['alterno', 'alternativo', 'alternate'],
    nombre: ['nombre', 'articulo', 'name', 'desc', 'descripcion'],
    sucursal: ['sucursal', 'branch'],
    costo: ['costo', 'cost', 'precio', 'price', 'valor', 'value'],
    existencia: ['existencia', 'existencias', 'stock', 'cant', 'cantidad', 'qty']
};

const $a = id => document.getElementById(id);
const normKey = k => String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// El lector de Excel pesa ~880 KB: solo se descarga cuando el administrador lo necesita
function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = XLSX_SRC;
        s.onload = resolve;
        s.onerror = () => reject(new Error('No se pudo cargar el lector de Excel'));
        document.head.appendChild(s);
    });
}

function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => { if (k === 'class') e.className = v; else e[k] = v; });
    children.forEach(c => e.append(c));
    return e;
}

async function initAdmin() {
    if (!ADMIN.initialized) {
        ADMIN.initialized = true;
        $a('inv-select-btn').addEventListener('click', () => $a('inv-file').click());
        $a('inv-file').addEventListener('change', onInventoryFile);
        $a('inv-template-btn').addEventListener('click', downloadInventoryTemplate);
        $a('user-form').addEventListener('submit', onCreateUser);
        $a('user-rol').addEventListener('change', () => { $a('user-sucursal').disabled = $a('user-rol').value !== 'operador'; });
    }
    await Promise.all([refreshResumen(), refreshUsers()]);
}

// Se llama al cerrar sesión: nada del panel queda en pantalla
function clearAdminData() {
    ['inv-resumen', 'user-list', 'inv-result'].forEach(id => $a(id).replaceChildren());
    $a('inv-result').hidden = true;
    $a('inv-progress').hidden = true;
    $a('user-msg').textContent = '';
}

// ---------- Inventario ----------
async function refreshResumen() {
    try {
        const { sucursales } = await api('/api/inventario?action=resumen');
        ADMIN.sucursales = sucursales;
        const box = $a('inv-resumen');
        box.replaceChildren(...sucursales.map(s =>
            el('div', { class: 'resumen-item' }, el('span', { class: 'resumen-n', textContent: String(s.articulos) }), el('span', { class: 'resumen-l', textContent: s.nombre }))));
        const sel = $a('user-sucursal');
        sel.replaceChildren(new Option('Todas las sucursales', ''));
        sucursales.forEach(s => sel.add(new Option(s.nombre, s.id)));
    } catch (e) {
        $a('inv-resumen').textContent = e.message;
    }
}

function mapRows(json) {
    const headers = Object.keys(json[0] || {});
    const col = {};
    headers.forEach(h => {
        const k = normKey(h);
        Object.entries(ADMIN_COLUMNS).forEach(([campo, alias]) => { if (alias.includes(k) && !col[campo]) col[campo] = h; });
    });
    const faltan = ['codigo', 'sucursal', 'existencia'].filter(c => !col[c]);
    if (faltan.length) {
        throw new Error(`Faltan columnas obligatorias: ${faltan.join(', ')}.\nColumnas encontradas: ${headers.join(', ') || 'ninguna'}.\nDescargue la plantilla para ver el formato.`);
    }
    return json.map((r, i) => ({
        fila: i + 2,   // fila de Excel (1 = encabezado)
        sucursal: r[col.sucursal], codigo: String(r[col.codigo] ?? '').trim(),
        alterno: col.alterno ? String(r[col.alterno] ?? '').trim() : '',
        nombre: col.nombre ? r[col.nombre] : '', costo: col.costo ? r[col.costo] : 0, existencia: r[col.existencia]
    })).filter(f => f.codigo !== '' || String(f.sucursal ?? '').trim() !== '');
}

async function onInventoryFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const prog = $a('inv-progress'), result = $a('inv-result');
    result.hidden = true;
    prog.hidden = false;
    prog.textContent = 'Leyendo el archivo…';
    $a('inv-select-btn').disabled = true;
    try {
        await loadXlsx();
        const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
        if (!wb.SheetNames.length) throw new Error('El archivo no contiene hojas.');
        const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        if (!json.length) throw new Error('La hoja está vacía.');
        const filas = mapRows(json);
        if (!filas.length) throw new Error('No se encontraron filas con datos.');

        if (!confirm(`Se cargarán ${filas.length} filas de "${file.name}".\nLos códigos que ya existen en cada sucursal se actualizarán (existencia, costo, nombre).\n\n¿Continuar?`)) {
            prog.hidden = true;
            return;
        }
        const total = { insertados: 0, actualizados: 0, rechazadas: 0, errores: [] };
        for (let i = 0; i < filas.length; i += CHUNK) {
            prog.textContent = `Cargando ${Math.min(i + CHUNK, filas.length)} de ${filas.length}…`;
            const r = await api('/api/inventario?action=cargar', { method: 'POST', body: { filas: filas.slice(i, i + CHUNK) } });
            total.insertados += r.insertados;
            total.actualizados += r.actualizados;
            total.rechazadas += r.rechazadas;
            total.errores.push(...r.errores);
        }
        prog.hidden = true;
        showInventoryResult(total);
        await refreshResumen();
    } catch (err) {
        prog.hidden = true;
        alert('No se pudo cargar el inventario: ' + err.message);
    } finally {
        $a('inv-select-btn').disabled = false;
    }
}

function showInventoryResult(t) {
    const box = $a('inv-result');
    box.replaceChildren(el('p', { textContent: `Nuevos: ${t.insertados} · Actualizados: ${t.actualizados} · Rechazados: ${t.rechazadas}` }));
    if (t.errores.length) {
        const ul = el('ul', { class: 'error-list' });
        t.errores.slice(0, 20).forEach(x => ul.append(el('li', { textContent: `Fila ${x.fila}: ${x.error}` })));
        if (t.rechazadas > 20) ul.append(el('li', { textContent: `…y ${t.rechazadas - 20} más` }));
        box.append(ul);
    }
    box.hidden = false;
}

async function downloadInventoryTemplate() {
    await loadXlsx();
    const ws = XLSX.utils.json_to_sheet([
        { Codigo: 'ART001', Alterno: '0735FA61', Nombre: 'ANGULO 2"X2"X1/4"', Sucursal: 'Capital', Costo: 12.5, Existencia: 40 },
        { Codigo: 'ART001', Alterno: '0735FA61', Nombre: 'ANGULO 2"X2"X1/4"', Sucursal: 'David', Costo: 12.5, Existencia: 15 }
    ]);
    ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 14 }, { wch: 10 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');
    XLSX.writeFile(wb, 'plantilla_inventario.xlsx');
}

// ---------- Usuarios ----------
async function refreshUsers() {
    try {
        const { usuarios } = await api('/api/usuarios');
        const tbody = el('tbody');
        usuarios.forEach(u => {
            const acciones = el('td', { class: 'user-actions' });
            const btnActivo = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', textContent: u.activo ? 'Desactivar' : 'Activar' });
            btnActivo.addEventListener('click', () => updateUser({ id: u.id, activo: !u.activo }));
            const btnClave = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', textContent: 'Cambiar clave' });
            btnClave.addEventListener('click', () => {
                const p = prompt(`Nueva contraseña para ${u.usuario} (mínimo 8 caracteres):`);
                if (p) updateUser({ id: u.id, password: p });
            });
            acciones.append(btnActivo, btnClave);
            tbody.append(el('tr', { class: u.activo ? '' : 'user-inactive' },
                el('td', { textContent: u.usuario }), el('td', { textContent: u.nombre }),
                el('td', { textContent: u.rol === 'admin' ? 'Administrador' : 'Operador' }),
                el('td', { textContent: u.rol === 'admin' ? 'Todas' : (u.sucursal || 'Todas') }),
                el('td', { textContent: u.activo ? 'Activo' : 'Inactivo' }), acciones));
        });
        const thead = el('thead', {}, el('tr', {}, ...['Usuario', 'Nombre', 'Rol', 'Sucursal', 'Estado', ''].map(t => el('th', { textContent: t }))));
        $a('user-list').replaceChildren(el('table', { class: 'items-table user-table' }, thead, tbody));
    } catch (e) {
        $a('user-list').textContent = e.message;
    }
}

async function updateUser(body) {
    try {
        await api('/api/usuarios?action=actualizar', { method: 'POST', body });
        $a('user-msg').textContent = 'Cambio guardado.';
        await refreshUsers();
    } catch (e) {
        alert(e.message);
    }
}

async function onCreateUser(e) {
    e.preventDefault();
    const msg = $a('user-msg');
    msg.textContent = '';
    try {
        await api('/api/usuarios?action=crear', {
            method: 'POST',
            body: {
                usuario: $a('user-usuario').value, nombre: $a('user-nombre').value, password: $a('user-pass').value,
                rol: $a('user-rol').value, sucursal_id: $a('user-sucursal').value || null
            }
        });
        $a('user-form').reset();
        $a('user-sucursal').disabled = false;
        msg.textContent = 'Usuario creado.';
        await refreshUsers();
    } catch (err) {
        msg.textContent = err.message;
    }
}
