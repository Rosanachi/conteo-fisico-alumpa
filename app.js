// Estado Global de la Aplicación
let inventory = [];
let selectedItem = null;
let currentFilter = 'all';
let searchQuery = '';
let renderLimit = 100;
const RENDER_PAGE_SIZE = 100;
let currentUser = null;      // { usuario, nombre, rol, sucursal_id, sucursal }
let currentCount = null;     // conteo abierto: { id, sucursal, ubicacion, ... }
// Claves de la versión local anterior (el inventario ya no se guarda en el navegador)
const LEGACY_STORAGE_KEYS = ['antigravity_inventory', 'antigravity_filename', 'antigravity_counter'];

// Escapa texto antes de insertarlo como HTML (evita inyección desde el Excel)
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Redondea a 2 decimales (evita 0.30000000000000004 y que 0.1+0.2-0.3 no sea 0)
function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normalizeKey(key) {
    return String(key).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// ----------------------------------------------------
// IMÁGENES DEL CATÁLOGO (regla: primeros 4 de Alterno = últimos 4 dígitos del código AL-xxxx, rellenado con ceros)
// ----------------------------------------------------
const CATALOG = { index: null, base: 'catalog/' };

function catalogKeyFromAlterno(alterno) {
    const k = String(alterno ?? '').trim().slice(0, 4);
    return /^\d{4}$/.test(k) ? k : null;
}

// Devuelve { state: 'matched'|'ambiguous'|'none', key4, code, cands }
function matchImagen(alterno) {
    const key4 = catalogKeyFromAlterno(alterno);
    if (!key4) return { state: 'none', key4: null, code: null, cands: [] };
    const codes = [...new Set((CATALOG.index?.[key4] || []).map(e => e.code))];
    if (codes.length === 0) return { state: 'none', key4, code: null, cands: [] };
    if (codes.length === 1) return { state: 'matched', key4, code: codes[0], cands: [] };
    return { state: 'ambiguous', key4, code: null, cands: codes };
}

// Hook de creación: asigna imagen automática a un artículo nuevo (no pisa una elección manual)
function asignarImagenAutomatica(item) {
    if (item.imgState === 'manual') return item;
    const m = matchImagen(item.alterno);
    item.imgKey = m.key4;
    item.imgCode = m.code;
    item.imgState = m.state;
    return item;
}

// URL de la imagen del artículo o null (sin match, ambiguo o índice no cargado)
function imageUrlFor(item) {
    let code = item.imgCode;
    let key4 = item.imgKey;
    if (item.imgState !== 'manual' && !code) {   // artículos guardados antes de esta función, o índice cargado después
        const m = matchImagen(item.alterno);
        code = m.code; key4 = m.key4;
    }
    if (!code || !key4) return null;
    const e = (CATALOG.index?.[key4] || []).find(x => x.code === code);
    return e ? CATALOG.base + e.file : null;
}

function thumbHtml(item, cls) {
    const url = imageUrlFor(item);
    if (!url) return `<span class="${cls} thumb-empty" title="Sin imagen en catálogo"></span>`;
    return `<img class="${cls}" src="${escapeHtml(url)}" loading="lazy" decoding="async" alt="">`;
}

async function loadCatalogIndex() {
    try {
        const r = await fetch(CATALOG.base + 'index.json');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        CATALOG.index = (await r.json()).items || {};
    } catch (e) {
        console.warn('Catálogo de imágenes no disponible:', e);
        CATALOG.index = {};
        return;
    }
    // Reasigna los artículos ya cargados (excepto los manuales)
    inventory.forEach(asignarImagenAutomatica);
    if (inventory.length && typeof renderList === 'function') renderList();
}

function debounce(fn, ms) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

// Elementos del DOM
const DOM = {
    showMoreBtn: document.getElementById('show-more-btn'),
    showMoreWrapper: document.getElementById('show-more-wrapper'),
    listNote: document.getElementById('list-note'),
    views: document.querySelectorAll('.view-panel'),
    dashboardView: document.getElementById('dashboard-view'),
    userChip: document.getElementById('user-chip'),
    userName: document.getElementById('user-name'),
    logoutBtn: document.getElementById('logout-btn'),
    finishCountBtn: document.getElementById('finish-count-btn'),
    finishModal: document.getElementById('finish-modal'),
    finishText: document.getElementById('finish-text'),
    finishCancelBtn: document.getElementById('finish-cancel-btn'),
    finishConfirmBtn: document.getElementById('finish-confirm-btn'),
    statusIndicator: document.getElementById('status-indicator'),
    statusText: document.getElementById('status-text'),
    loadedFileName: document.getElementById('loaded-file-name'),
    
    // Stats
    statTotal: document.getElementById('stat-total'),
    statCounted: document.getElementById('stat-counted'),
    statCountedPct: document.getElementById('stat-counted-pct'),
    statPending: document.getElementById('stat-pending'),
    
    // Badges en pestañas
    badgeAll: document.getElementById('badge-all'),
    badgePending: document.getElementById('badge-pending'),
    badgeCounted: document.getElementById('badge-counted'),
    
    // Búsqueda y Tabla
    searchInput: document.getElementById('search-input'),
    clearSearchBtn: document.getElementById('clear-search-btn'),
    itemsTableBody: document.getElementById('items-table-body'),
    itemsCardsGrid: document.getElementById('items-cards-grid'),
    emptyResultsState: document.getElementById('empty-results-state'),
    filterTabs: document.querySelectorAll('.filter-tab'),
    
    // Botones Principales
    
    // Modal de Conteo
    countingModal: document.getElementById('counting-modal'),
    modalCloseX: document.getElementById('modal-close-x'),
    modalCancelBtn: document.getElementById('modal-cancel-btn'),
    modalSaveBtn: document.getElementById('modal-save-btn'),
    modalArticleImg: document.getElementById('modal-article-img'),
    modalArticleName: document.getElementById('modal-article-name'),
    modalArticleCode: document.getElementById('modal-article-code'),
    modalArticleAlt: document.getElementById('modal-article-alt'),
    modalArticleWh: document.getElementById('modal-article-wh'),
    modalArticleCost: document.getElementById('modal-article-cost'),
    modalArticleExist: document.getElementById('modal-article-exist'),
    countExpression: document.getElementById('count-expression'),
    expressionPreview: document.getElementById('expression-preview'),
    quickAdjustButtons: document.querySelectorAll('.btn-adjust'),
    summaryTotalCounted: document.getElementById('summary-total-counted')
};

// ----------------------------------------------------
// 1. INICIALIZACIÓN
// ----------------------------------------------------
function init() {
    // Borra restos de la versión local anterior (inventario guardado en el navegador)
    LEGACY_STORAGE_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* ignorar */ } });
    setupEventListeners();
    registerServiceWorker();
    startSession();
    loadCatalogIndex();
    // Si una imagen falla (sin conexión o archivo ausente) se muestra el recuadro vacío
    document.addEventListener('error', (e) => {
        const t = e.target;
        if (t && t.id === 'modal-article-img') { t.hidden = true; return; }
        if (t && t.tagName === 'IMG' && t.classList.contains('thumb-img')) {
            t.removeAttribute('src');
            t.classList.add('thumb-empty');
        }
    }, true);
}

// Permite usar la app sin conexión
function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker no registrado:', err));
    }
}

// Escuchar eventos de la UI
function setupEventListeners() {
    // Búsqueda
    DOM.searchInput.addEventListener('input', debounce(handleSearch, 200));
    DOM.clearSearchBtn.addEventListener('click', clearSearch);
    DOM.showMoreBtn.addEventListener('click', () => {
        renderLimit += RENDER_PAGE_SIZE;
        renderList();
    });
    
    // Al presionar Enter en búsqueda: si hay una única coincidencia exacta de código, abre el modal.
    // Si el código existe en varias bodegas, deja la lista filtrada para elegir.
    DOM.searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            handleSearch(); // aplicar de inmediato (sin esperar el debounce)
            const query = DOM.searchInput.value.trim().toLowerCase();
            if (query) {
                const matches = inventory.filter(item => String(item.codigo).trim().toLowerCase() === query);
                if (matches.length === 1) {
                    openCountingModal(matches[0]);
                }
            }
        }
    });

    // Modal: Escape cierra, Tab queda dentro del modal
    document.addEventListener('keydown', function(e) {
        if (!DOM.countingModal.classList.contains('active')) return;
        if (e.key === 'Escape') {
            closeCountingModal();
        } else if (e.key === 'Tab') {
            const focusables = DOM.countingModal.querySelectorAll('button:not([disabled]), input:not([disabled])');
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });

    // Pestañas de Filtro
    DOM.filterTabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            DOM.filterTabs.forEach(t => t.classList.remove('active'));
            const clickedTab = e.currentTarget;
            clickedTab.classList.add('active');
            currentFilter = clickedTab.dataset.filter;
            renderLimit = RENDER_PAGE_SIZE;
            renderList();
        });
    });

    // Botones de acción principales
    DOM.finishCountBtn.addEventListener('click', openFinishModal);
    DOM.finishCancelBtn.addEventListener('click', closeFinishModal);
    DOM.finishConfirmBtn.addEventListener('click', finishCount);
    DOM.logoutBtn.addEventListener('click', logout);
    setupSessionListeners();

    // Modal de Conteo
    DOM.modalCloseX.addEventListener('click', closeCountingModal);
    DOM.modalCancelBtn.addEventListener('click', closeCountingModal);
    DOM.modalSaveBtn.addEventListener('click', saveCount);
    
    DOM.countExpression.addEventListener('input', handleExpressionChange);
    
    // Botones incrementales (+1, +5, etc.)
    DOM.quickAdjustButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const val = parseFloat(btn.dataset.val);
            adjustExpressionCount(val);
        });
    });

    // Teclado Numérico Virtual
    const keypadButtons = document.querySelectorAll('.keypad-btn');
    keypadButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            handleKeypadPress(key);
        });
    });
}

// ----------------------------------------------------
// 4. CONTROL DE PANTALLAS (VISTAS)
// ----------------------------------------------------
// Muestra solo la pantalla indicada (login-view, select-view, admin-view, dashboard-view)
function showView(id) {
    DOM.views.forEach(v => v.classList.toggle('active-view', v.id === id));
    DOM.userChip.hidden = !currentUser;
    if (currentUser) DOM.userName.textContent = `${currentUser.nombre} (${currentUser.rol === 'admin' ? 'Administrador' : 'Operador'})`;
    window.scrollTo(0, 0);
}

function showDashboard() {
    showView('dashboard-view');
    DOM.loadedFileName.textContent = `${currentCount.sucursal} › ${currentCount.ubicacion}`;
    setStatus('online', 'Conteo en curso');
    updateStats();
    renderList();
}

// ----------------------------------------------------
// 4b. SESIÓN Y FLUJO: login -> sucursal/ubicación -> conteo -> finalizar
// ----------------------------------------------------
const $ = id => document.getElementById(id);

function showFormError(id, msg) {
    const el = $(id);
    el.textContent = msg || '';
    el.hidden = !msg;
}

// Al abrir la app: ¿hay sesión? ¿hay un conteo abierto?
async function startSession() {
    try {
        const { usuario } = await api('/api/auth?action=me');
        currentUser = usuario;
    } catch (e) {
        currentUser = null;
        setStatus('offline', 'Sin sesión');
        showView('login-view');
        return;
    }
    await routeAfterLogin();
}

async function routeAfterLogin() {
    if (currentUser.rol === 'admin') {
        setStatus('online', 'Administrador');
        showView('admin-view');
        if (typeof initAdmin === 'function') initAdmin();
        return;
    }
    try {
        const { conteo } = await api('/api/conteo?action=actual');
        if (conteo) return await openCount(conteo);
        await showSelectView();
    } catch (e) {
        alert(e.message);
        showView('login-view');
    }
}

function setupSessionListeners() {
    $('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        showFormError('login-error', '');
        const btn = e.submitter || $('login-form').querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            const { usuario } = await api('/api/auth?action=login', {
                method: 'POST', body: { usuario: $('login-user').value, password: $('login-pass').value }
            });
            $('login-pass').value = '';
            currentUser = usuario;
            await routeAfterLogin();
        } catch (err) {
            showFormError('login-error', err.message);
        } finally {
            btn.disabled = false;
        }
    });

    $('select-sucursal').addEventListener('change', loadUbicaciones);
    $('select-ubicacion').addEventListener('change', () => { $('select-start-btn').disabled = !$('select-ubicacion').value; });
    $('select-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        showFormError('select-error', '');
        $('select-start-btn').disabled = true;
        try {
            const { conteo } = await api('/api/conteo?action=iniciar', {
                method: 'POST', body: { ubicacion_id: Number($('select-ubicacion').value) }
            });
            await openCount(conteo);
        } catch (err) {
            showFormError('select-error', err.message);
            $('select-start-btn').disabled = false;
        }
    });
}

// Pantalla "Sucursal y ubicación" (obligatoria antes de contar)
async function showSelectView(aviso) {
    inventory = [];
    currentCount = null;
    $('select-notice').textContent = aviso || '';
    $('select-notice').hidden = !aviso;
    showFormError('select-error', '');
    setStatus('online', 'Listo para contar');
    showView('select-view');
    const { sucursales } = await api('/api/catalogo');
    const sel = $('select-sucursal');
    sel.replaceChildren(new Option('Seleccione una sucursal…', ''));
    sucursales.forEach(s => sel.add(new Option(s.nombre, s.id)));
    if (sucursales.length === 1) sel.value = String(sucursales[0].id);
    await loadUbicaciones();
}

async function loadUbicaciones() {
    const sel = $('select-ubicacion');
    $('select-start-btn').disabled = true;
    sel.replaceChildren(new Option('Seleccione una ubicación…', ''));
    const sucId = $('select-sucursal').value;
    sel.disabled = !sucId;
    if (!sucId) return;
    try {
        const { ubicaciones } = await api('/api/catalogo?sucursal=' + encodeURIComponent(sucId));
        ubicaciones.forEach(u => sel.add(new Option(u.nombre, u.id)));
    } catch (err) {
        showFormError('select-error', err.message);
    }
}

// Descarga los artículos de la sucursal y lo ya contado, y muestra la pantalla de conteo
async function openCount(conteo) {
    setStatus('loading', 'Cargando artículos...');
    showView('dashboard-view');
    const data = await api('/api/conteo?action=articulos');
    currentCount = data.conteo;
    const porArticulo = new Map();
    data.lineas.forEach(l => {
        if (!porArticulo.has(l.articulo_id)) porArticulo.set(l.articulo_id, []);
        porArticulo.get(l.articulo_id).push({ id: l.id, qty: l.cantidad, desc: l.detalle });
    });
    inventory = data.articulos.map(a => {
        const parciales = porArticulo.get(a.id) || [];
        const contado = parciales.length ? round2(parciales.reduce((s, p) => s + p.qty, 0)) : null;
        const item = {
            id: a.id, codigo: a.codigo, alterno: a.alterno || '', nombre: a.nombre,
            costo: a.costo, existencia: a.existencia,
            contado, partialCounts: parciales
        };
        return asignarImagenAutomatica(item);
    });
    renderLimit = RENDER_PAGE_SIZE;
    currentFilter = 'all';
    DOM.filterTabs.forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
    DOM.searchInput.value = '';
    searchQuery = '';
    showDashboard();
    DOM.searchInput.focus();
}

// La sesión venció (12 h) o el administrador desactivó al usuario
function onSessionExpired() {
    if (!currentUser) return;
    DOM.finishModal.classList.remove('active');
    DOM.countingModal.classList.remove('active');
    clearScreenData();
    currentUser = null;
    setStatus('offline', 'Sin sesión');
    showView('login-view');
    showFormError('login-error', 'Su sesión venció. Inicie sesión de nuevo; el conteo abierto se conserva.');
}

async function logout() {
    if (currentCount && !confirm('Tiene un conteo abierto. Si sale ahora podrá retomarlo al volver a entrar.\n\n¿Cerrar sesión?')) return;
    try { await api('/api/auth?action=logout', { method: 'POST' }); } catch (e) { /* igual se limpia la pantalla */ }
    clearScreenData();
    currentUser = null;
    setStatus('offline', 'Sin sesión');
    showView('login-view');
}

// Limpieza de pantalla: nada del conteo queda en memoria ni en el navegador
function clearScreenData() {
    inventory = [];
    currentCount = null;
    selectedItem = null;
    DOM.itemsTableBody.innerHTML = '';
    DOM.itemsCardsGrid.innerHTML = '';
    DOM.searchInput.value = '';
    searchQuery = '';
    if (typeof clearAdminData === 'function') clearAdminData();
}

// "Finalizado Conteo": confirmación -> cierra el conteo en el servidor -> limpia la pantalla
function openFinishModal() {
    const contados = inventory.filter(i => i.contado !== null).length;
    DOM.finishText.textContent = contados === 0
        ? `No ha contado ningún artículo en ${currentCount.ubicacion}. Si finaliza, el conteo quedará vacío.`
        : `Va a finalizar el conteo de ${currentCount.sucursal} › ${currentCount.ubicacion} con ${contados} artículo(s) contado(s). Después no podrá modificarlo.`;
    DOM.finishModal.classList.add('active');
    DOM.finishCancelBtn.focus();
}

function closeFinishModal() {
    DOM.finishModal.classList.remove('active');
}

async function finishCount() {
    DOM.finishConfirmBtn.disabled = true;
    try {
        const r = await api('/api/conteo?action=finalizar', { method: 'POST' });
        closeFinishModal();
        const lugar = `${currentCount.sucursal} › ${currentCount.ubicacion}`;
        clearScreenData();
        await showSelectView(`Conteo finalizado en ${lugar}: ${r.articulos_contados} artículo(s). Puede iniciar otro conteo.`);
    } catch (e) {
        closeFinishModal();
        if (await handleCountGone(e)) return;
        alert(e.message);
    } finally {
        DOM.finishConfirmBtn.disabled = false;
    }
}

// El conteo abierto ya no existe (el administrador lo borró): se limpia la pantalla y se vuelve a la selección
async function handleCountGone(e) {
    if (!(e && e.status === 409 && /No tiene un conteo abierto/.test(e.message))) return false;
    const lugar = currentCount ? `${currentCount.sucursal} › ${currentCount.ubicacion}` : 'esta ubicación';
    DOM.countingModal.classList.remove('active');
    clearScreenData();
    await showSelectView(`El administrador borró el conteo de ${lugar}. Puede iniciar uno nuevo.`);
    return true;
}

function setStatus(type, text) {
    DOM.statusIndicator.className = `status-badge status-${type}`;
    DOM.statusText.textContent = text;
}

// ----------------------------------------------------
// 5. CÁLCULO DE ESTADÍSTICAS Y MÉTRICAS
// ----------------------------------------------------
function updateStats() {
    const total = inventory.length;
    const counted = inventory.filter(item => item.contado !== null).length;
    const pending = total - counted;
    
    // Actualizar números de Dashboard
    DOM.statTotal.textContent = total;
    DOM.statCounted.textContent = counted;
    DOM.statPending.textContent = pending;
    
    // Porcentaje
    const pct = total > 0 ? Math.round((counted / total) * 100) : 0;
    DOM.statCountedPct.textContent = `${pct}% del total`;
    
    // Badges en las pestañas
    DOM.badgeAll.textContent = total;
    DOM.badgePending.textContent = pending;
    DOM.badgeCounted.textContent = counted;
}

// ----------------------------------------------------
// 6. BUSCADOR Y RENDERIZADO DE ELEMENTOS
// ----------------------------------------------------
function handleSearch() {
    searchQuery = DOM.searchInput.value.trim().toLowerCase();
    renderLimit = RENDER_PAGE_SIZE;
    
    // Mostrar/ocultar botón para limpiar búsqueda
    if (searchQuery) {
        DOM.clearSearchBtn.style.display = 'block';
    } else {
        DOM.clearSearchBtn.style.display = 'none';
    }
    
    renderList();
}

function clearSearch() {
    DOM.searchInput.value = '';
    searchQuery = '';
    renderLimit = RENDER_PAGE_SIZE;
    DOM.clearSearchBtn.style.display = 'none';
    DOM.searchInput.focus();
    renderList();
}

// Filtra e inyecta los artículos en la tabla y cuadrícula de tarjetas
function renderList() {
    DOM.itemsTableBody.innerHTML = '';
    DOM.itemsCardsGrid.innerHTML = '';
    
    // 1. Filtrar lista por búsqueda y por pestaña de filtro
    const filteredItems = inventory.filter(item => {
        // Filtro de pestaña
        if (currentFilter === 'pending' && item.contado !== null) return false;
        if (currentFilter === 'counted' && item.contado === null) return false;
        
        // Filtro de búsqueda
        if (searchQuery) {
            const matchesCodeExact = String(item.codigo).toLowerCase().trim() === searchQuery;
            const matchesNameApprox = item.nombre.toLowerCase().includes(searchQuery);
            const matchesAltApprox = item.alterno ? item.alterno.toLowerCase().includes(searchQuery) : false;
            
            return matchesCodeExact || matchesNameApprox || matchesAltApprox;
        }
        
        return true;
    });
    
    // Mostrar estado vacío si no hay resultados
    DOM.showMoreWrapper.style.display = 'none';
    DOM.listNote.style.display = 'none';
    if (filteredItems.length === 0) {
        DOM.emptyResultsState.style.display = 'flex';
        return;
    } else {
        DOM.emptyResultsState.style.display = 'none';
    }
    
    // 2. Renderizar solo una parte (rendimiento con catálogos grandes)
    const visibleItems = filteredItems.slice(0, renderLimit);
    if (filteredItems.length > visibleItems.length) {
        DOM.listNote.textContent = `Mostrando ${visibleItems.length} de ${filteredItems.length} artículos`;
        DOM.listNote.style.display = 'block';
        DOM.showMoreWrapper.style.display = 'flex';
    }
    
    // 3. Renderizar filas y tarjetas
    visibleItems.forEach(item => {
        // Renderizado para tabla (PC)
        const tr = createTableRow(item);
        DOM.itemsTableBody.appendChild(tr);
        
        // Renderizado para tarjetas (Móvil)
        const card = createTableCellCard(item);
        DOM.itemsCardsGrid.appendChild(card);
    });
}

// Crea la fila para la tabla de escritorio
function createTableRow(item) {
    const tr = document.createElement('tr');
    
    // Asignar clase según estado de conteo e historial
    // El operador no ve diferencias: la existencia teórica es de toda la sucursal y él cuenta una sola ubicación
    tr.className = item.contado === null ? 'row-not-counted' : 'row-counted-no-diff';
    const contadoStr = item.contado !== null ? item.contado : '-';
    
    tr.innerHTML = `
        <td class="thumb-col">${thumbHtml(item, 'thumb thumb-img')}</td>
        <td><strong>${escapeHtml(item.codigo)}</strong></td>
        <td>${item.alterno ? escapeHtml(item.alterno) : '<span class="val-muted">-</span>'}</td>
        <td>${escapeHtml(item.nombre)}</td>
        <td class="num-col">$${item.costo.toFixed(2)}</td>
        <td class="num-col"><strong>${item.existencia}</strong></td>
        <td class="num-col font-weight-bold" style="font-size:1.05rem;">${contadoStr}</td>
        <td class="action-col">
            <button type="button" class="btn btn-secondary btn-sm">
                ${item.contado !== null ? 'Editar' : 'Contar'}
            </button>
        </td>
    `;
    
    // Al hacer clic en la fila, abre el modal
    tr.addEventListener('click', () => openCountingModal(item));
    
    return tr;
}

// Crea la tarjeta para la vista móvil
function createTableCellCard(item) {
    const card = document.createElement('div');
    
    const borderClass = item.contado === null ? 'row-not-counted' : 'row-counted-no-diff';
    card.className = `card item-card ${borderClass}`;
    const contadoStr = item.contado !== null ? item.contado : '-';
    
    card.innerHTML = `
        <div class="card-header-row">
            <div class="card-code-section">
                <span class="card-code">${escapeHtml(item.codigo)}</span>
                <span class="card-alt">${item.alterno ? 'Alt: ' + escapeHtml(item.alterno) : 'Sin alterno'}</span>
            </div>
            <div>
                ${item.contado !== null ? 
                  '<span class="col-tag-status col-tag-success">Contado</span>' : 
                  '<span class="col-tag-status col-tag-muted">Pendiente</span>'
                }
            </div>
        </div>
        <div class="card-name-row">
            ${thumbHtml(item, 'thumb thumb-img')}
            <div class="card-name">${escapeHtml(item.nombre)}</div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <span class="card-wh-badge" style="background-color: rgba(59, 130, 246, 0.05); color: var(--primary); border-color: rgba(59, 130, 246, 0.15);">Costo: $${item.costo.toFixed(2)}</span>
        </div>
        <div class="card-stocks-row">
            <div class="card-stock-item">
                <span class="card-stock-label">Exist.</span>
                <span class="card-stock-val">${item.existencia}</span>
            </div>
            <div class="card-stock-item" style="border-left: 1px solid var(--border-color);">
                <span class="card-stock-label">Contado</span>
                <span class="card-stock-val" style="font-size:1.1rem; color:var(--primary);">${contadoStr}</span>
            </div>
        </div>
    `;
    
    card.addEventListener('click', () => openCountingModal(item));
    
    return card;
}


// ----------------------------------------------------
// 7. LÓGICA DEL MODAL DE CONTEO Y HISTORIAL
// ----------------------------------------------------
function openCountingModal(item) {
    // Clonar para poder cancelar cambios
    selectedItem = JSON.parse(JSON.stringify(item));
    
    // Llenar detalles del artículo
    DOM.modalArticleName.textContent = selectedItem.nombre;
    DOM.modalArticleCode.textContent = selectedItem.codigo;
    DOM.modalArticleAlt.textContent = selectedItem.alterno || '-';
    DOM.modalArticleWh.textContent = currentCount ? `${currentCount.sucursal} › ${currentCount.ubicacion}` : '-';
    DOM.modalArticleCost.textContent = `$${selectedItem.costo.toFixed(2)}`;
    DOM.modalArticleExist.textContent = selectedItem.existencia;
    const modalImgUrl = imageUrlFor(selectedItem);
    if (modalImgUrl) {
        DOM.modalArticleImg.src = modalImgUrl;
        DOM.modalArticleImg.hidden = false;
    } else {
        DOM.modalArticleImg.removeAttribute('src');
        DOM.modalArticleImg.hidden = true;
    }
    
    // Campo de cantidad: si ya se contó, muestra lo contado para corregirlo o sumarle (ej. 7+3)
    DOM.countExpression.value = selectedItem.contado !== null ? String(selectedItem.contado) : '';
    DOM.expressionPreview.style.display = 'none';
    
    // Calcular totales del modal
    calculateModalTotal();
    
    // Mostrar modal
    DOM.countingModal.classList.add('active');
    
    // Hacer foco en el campo de expresión para agilizar entrada (especialmente con lectores físicos)
    setTimeout(() => {
        DOM.countExpression.focus();
        DOM.countExpression.select();
    }, 100);
}

function closeCountingModal() {
    DOM.countingModal.classList.remove('active');
    selectedItem = null;
    DOM.searchInput.focus(); // regresar foco al buscador
}

// Maneja cambios en el input de expresión matemática
function handleExpressionChange() {
    calculateModalTotal();
}

// Lógica para el teclado numérico virtual
function handleKeypadPress(key) {
    if (!selectedItem) return;
    
    const currentExpr = DOM.countExpression.value;
    
    if (key === 'clear') {
        DOM.countExpression.value = '';
    } else if (key === 'backspace') {
        DOM.countExpression.value = currentExpr.slice(0, -1);
    } else if (key === 'ok') {
        saveCount();
        return;
    } else {
        DOM.countExpression.value = currentExpr + key;
    }
    
    calculateModalTotal();
    DOM.countExpression.focus();
}

// Evalúa una expresión aritmética de forma segura (ej. 10+20*5)
function safeEvaluate(str) {
    // Normalizar expresión
    str = str.replace(/,/g, '.').replace(/\s+/g, '');
    
    if (str === '') return 0;
    
    // Validar caracteres permitidos (Números y operadores únicamente)
    if (!/^[0-9+\-*/().]*$/.test(str)) {
        return NaN;
    }
    
    // Analizador recursivo propio (sin eval ni new Function)
    let pos = 0;
    const fail = () => { throw new Error('expresion invalida'); };

    function parseNumber() {
        const m = /^\d*\.?\d+|^\d+\.?/.exec(str.slice(pos));
        if (!m) fail();
        pos += m[0].length;
        return parseFloat(m[0]);
    }
    function parseFactor() {
        if (str[pos] === '-') { pos++; return -parseFactor(); }
        if (str[pos] === '+') { pos++; return parseFactor(); }
        if (str[pos] === '(') {
            pos++;
            const v = parseExpr();
            if (str[pos] !== ')') fail();
            pos++;
            return v;
        }
        return parseNumber();
    }
    function parseTerm() {
        let v = parseFactor();
        while (str[pos] === '*' || str[pos] === '/') {
            const op = str[pos++];
            const r = parseFactor();
            v = op === '*' ? v * r : v / r;
        }
        return v;
    }
    function parseExpr() {
        let v = parseTerm();
        while (str[pos] === '+' || str[pos] === '-') {
            const op = str[pos++];
            const r = parseTerm();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    }

    try {
        const val = parseExpr();
        if (pos !== str.length) fail();
        return Number.isFinite(val) ? Math.round(val * 1e6) / 1e6 : NaN;
    } catch (e) {
        return NaN;
    }
}

// Suma el input aritmético + el historial acumulado
function calculateModalTotal() {
    if (!selectedItem) return;
    
    const exprValue = DOM.countExpression.value.trim();
    let exprParsed = safeEvaluate(exprValue);
    
    // Controlar el preview visual de la fórmula
    if (exprValue !== '' && (exprValue.includes('+') || exprValue.includes('-') || exprValue.includes('*') || exprValue.includes('/'))) {
        if (isNaN(exprParsed)) {
            DOM.expressionPreview.textContent = 'Expresión inválida';
            DOM.expressionPreview.style.color = 'var(--danger)';
            DOM.expressionPreview.style.display = 'block';
            exprParsed = 0;
        } else if (exprParsed < 0) {
            DOM.expressionPreview.textContent = `= ${exprParsed} (no puede ser negativo)`;
            DOM.expressionPreview.style.color = 'var(--danger)';
            DOM.expressionPreview.style.display = 'block';
            exprParsed = 0;
        } else {
            DOM.expressionPreview.textContent = `= ${exprParsed}`;
            DOM.expressionPreview.style.color = 'var(--success)';
            DOM.expressionPreview.style.display = 'block';
        }
    } else {
        DOM.expressionPreview.style.display = 'none';
        if (isNaN(exprParsed) || exprParsed < 0) exprParsed = 0;
    }
    
    const totalCounted = round2(exprParsed);
    
    // Guardar conteo momentáneo en el clon
    selectedItem.contado = totalCounted;
    
    // Actualizar UI del modal
    DOM.summaryTotalCounted.textContent = selectedItem.contado;
}

// Permite usar botones +1, +5, -10 sobre el input actual
function adjustExpressionCount(val) {
    const exprValue = DOM.countExpression.value.trim();
    let currentVal = safeEvaluate(exprValue);
    
    if (isNaN(currentVal) || exprValue === '') {
        currentVal = 0;
    }
    
    const newVal = Math.max(0, currentVal + val); // no permitir totales negativos
    DOM.countExpression.value = newVal;
    calculateModalTotal();
    DOM.countExpression.focus();
}

// Guarda el conteo del artículo en el servidor y, si se guardó, actualiza la lista en pantalla
let savingCount = false;
async function saveCount() {
    if (!selectedItem || savingCount) return;
    
    // No guardar si la expresión escrita es inválida o negativa
    const rawExpr = DOM.countExpression.value.trim();
    if (rawExpr !== '') {
        const parsed = safeEvaluate(rawExpr);
        if (isNaN(parsed) || parsed < 0) {
            alert('La cantidad escrita no es válida. Corríjala antes de guardar.');
            DOM.countExpression.focus();
            return;
        }
    }

    // Si el usuario tiene una expresión incompleta o no procesada en el input principal,
    // se sumará antes de guardar.
    calculateModalTotal();
    
    const realIndex = inventory.findIndex(item => item.id === selectedItem.id);
    if (realIndex === -1) return closeCountingModal();

    // Una sola línea con lo escrito (incluso 0). Campo vacío = artículo pendiente.
    const hasInput = rawExpr !== '';
    if (!hasInput && inventory[realIndex].contado !== null &&
        !confirm('El campo de cantidad está vacío. ¿Quitar el conteo de este artículo y dejarlo pendiente?')) {
        DOM.countExpression.focus();
        return;
    }
    const lineas = hasInput ? [{ cantidad: round2(safeEvaluate(rawExpr)), detalle: 'Directo' }] : [];

    savingCount = true;
    DOM.modalSaveBtn.disabled = true;
    try {
        const r = await api('/api/conteo?action=guardar', {
            method: 'POST', body: { articulo_id: selectedItem.id, parciales: lineas }
        });
        const item = inventory[realIndex];
        item.partialCounts = r.lineas.map(l => ({ id: l.id, qty: l.cantidad, desc: l.detalle }));
        item.contado = item.partialCounts.length
            ? round2(item.partialCounts.reduce((s, p) => s + p.qty, 0))
            : null;
        updateStats();
        renderList();
        closeCountingModal();
    } catch (e) {
        if (await handleCountGone(e)) return;
        // No se cierra el modal: lo escrito no se pierde y puede reintentar
        alert('No se pudo guardar el conteo: ' + e.message);
    } finally {
        savingCount = false;
        DOM.modalSaveBtn.disabled = false;
    }
}


// ----------------------------------------------------
// 9. EVENTOS DE INICIO
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', init);
