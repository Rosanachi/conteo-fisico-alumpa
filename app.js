// Estado Global de la Aplicación
let inventory = [];
let selectedItem = null;
let currentFilter = 'all';
let searchQuery = '';
let fileName = 'inventario.xlsx';

// Elementos del DOM
const DOM = {
    uploadView: document.getElementById('upload-view'),
    dashboardView: document.getElementById('dashboard-view'),
    excelFileInput: document.getElementById('excel-file-input'),
    statusIndicator: document.getElementById('status-indicator'),
    statusText: document.getElementById('status-text'),
    loadedFileName: document.getElementById('loaded-file-name'),
    
    // Stats
    statTotal: document.getElementById('stat-total'),
    statCounted: document.getElementById('stat-counted'),
    statCountedPct: document.getElementById('stat-counted-pct'),
    statPending: document.getElementById('stat-pending'),
    statDiff: document.getElementById('stat-diff'),
    
    // Badges en pestañas
    badgeAll: document.getElementById('badge-all'),
    badgePending: document.getElementById('badge-pending'),
    badgeCounted: document.getElementById('badge-counted'),
    badgeDiff: document.getElementById('badge-diff'),
    
    // Búsqueda y Tabla
    searchInput: document.getElementById('search-input'),
    clearSearchBtn: document.getElementById('clear-search-btn'),
    itemsTableBody: document.getElementById('items-table-body'),
    itemsCardsGrid: document.getElementById('items-cards-grid'),
    emptyResultsState: document.getElementById('empty-results-state'),
    filterTabs: document.querySelectorAll('.filter-tab'),
    
    // Botones Principales
    downloadTemplateBtn: document.getElementById('download-template-btn'),
    downloadResultsBtn: document.getElementById('download-results-btn'),
    clearCountsBtn: document.getElementById('clear-counts-btn'),
    loadNewFileBtn: document.getElementById('load-new-file-btn'),
    
    // Modal de Conteo
    countingModal: document.getElementById('counting-modal'),
    modalCloseX: document.getElementById('modal-close-x'),
    modalCancelBtn: document.getElementById('modal-cancel-btn'),
    modalSaveBtn: document.getElementById('modal-save-btn'),
    modalArticleName: document.getElementById('modal-article-name'),
    modalArticleCode: document.getElementById('modal-article-code'),
    modalArticleAlt: document.getElementById('modal-article-alt'),
    modalArticleWh: document.getElementById('modal-article-wh'),
    modalArticleCost: document.getElementById('modal-article-cost'),
    modalArticleExist: document.getElementById('modal-article-exist'),
    countExpression: document.getElementById('count-expression'),
    expressionPreview: document.getElementById('expression-preview'),
    quickAdjustButtons: document.querySelectorAll('.btn-adjust'),
    partialQty: document.getElementById('partial-qty'),
    partialDesc: document.getElementById('partial-desc'),
    addPartialBtn: document.getElementById('add-partial-btn'),
    partialList: document.getElementById('partial-list'),
    partialEmpty: document.getElementById('partial-empty'),
    summaryTotalCounted: document.getElementById('summary-total-counted'),
    summaryDifference: document.getElementById('summary-difference')
};

// ----------------------------------------------------
// 1. INICIALIZACIÓN
// ----------------------------------------------------
function init() {
    setupEventListeners();
    loadFromLocalStorage();
}

// Escuchar eventos de la UI
function setupEventListeners() {
    // Carga de archivos
    DOM.excelFileInput.addEventListener('change', handleFileSelect);
    setupDragAndDrop();

    // Descarga de Plantilla
    DOM.downloadTemplateBtn.addEventListener('click', downloadTemplate);

    // Búsqueda
    DOM.searchInput.addEventListener('input', handleSearch);
    DOM.clearSearchBtn.addEventListener('click', clearSearch);
    
    // Al presionar Enter en búsqueda: Si hay coincidencia exacta de código, abre el modal
    DOM.searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            const query = DOM.searchInput.value.trim().toLowerCase();
            if (query) {
                // Buscar coincidencia exacta por código
                const match = inventory.find(item => String(item.codigo).trim().toLowerCase() === query);
                if (match) {
                    openCountingModal(match);
                }
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
            renderList();
        });
    });

    // Botones de acción principales
    DOM.downloadResultsBtn.addEventListener('click', downloadResults);
    DOM.clearCountsBtn.addEventListener('click', confirmClearCounts);
    DOM.loadNewFileBtn.addEventListener('click', confirmLoadNewFile);

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

    // Conteos parciales
    DOM.addPartialBtn.addEventListener('click', addPartialCount);
    DOM.partialQty.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addPartialCount();
        }
    });
    DOM.partialDesc.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addPartialCount();
        }
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
// 2. LECTURA Y CARGA DE ARCHIVOS EXCEL
// ----------------------------------------------------
function setupDragAndDrop() {
    const dropZone = DOM.uploadView.querySelector('.upload-card');
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0 && files[0].name.match(/\.(xlsx|xls)$/i)) {
            processFile(files[0]);
        } else {
            alert('Por favor, arrastre únicamente un archivo de Excel (.xlsx o .xls).');
        }
    }, false);
    
    // También permitir hacer click en la tarjeta para subir
    dropZone.addEventListener('click', (e) => {
        // Evitar triggers infinitos si se da click al botón interno
        if (e.target.tagName !== 'BUTTON') {
            DOM.excelFileInput.click();
        }
    });
}

function handleFileSelect(e) {
    const files = e.target.files;
    if (files.length > 0) {
        processFile(files[0]);
    }
}

function processFile(file) {
    fileName = file.name;
    const reader = new FileReader();
    
    // Cambiar estado a cargando
    setStatus('loading', 'Cargando archivo...');
    
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            
            if (workbook.SheetNames.length === 0) {
                throw new Error("El archivo Excel no contiene hojas de trabajo.");
            }
            
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
            
            if (jsonData.length === 0) {
                throw new Error("La hoja de cálculo está vacía.");
            }
            
            // Procesar y normalizar columnas
            inventory = mapExcelData(jsonData);
            
            // Guardar en LocalStorage y cambiar de vista
            saveToLocalStorage();
            showDashboard();
            
        } catch (err) {
            console.error(err);
            alert("Error al procesar el archivo Excel: " + err.message);
            setStatus('offline', 'Sin Archivo');
        }
    };
    
    reader.onerror = function() {
        alert("Error al leer el archivo.");
        setStatus('offline', 'Sin Archivo');
    };
    
    reader.readAsArrayBuffer(file);
}

// Normaliza las columnas para tolerar diferentes encabezados
function mapExcelData(data) {
    return data.map((row, index) => {
        const item = {};
        
        // Helper para buscar columnas de forma insensible a mayúsculas/minúsculas y acentos
        const getValueByPossibleKeys = (keys) => {
            for (let key in row) {
                const cleanKey = key.toLowerCase()
                                    .normalize("NFD")
                                    .replace(/[\u0300-\u036f]/g, "") // quitar acentos
                                    .trim();
                if (keys.includes(cleanKey)) {
                    return row[key];
                }
            }
            return "";
        };

        item.id = index;
        item.codigo = String(getValueByPossibleKeys(['codigo', 'code'])).trim();
        item.alterno = String(getValueByPossibleKeys(['alterno', 'alternativo', 'alternate'])).trim();
        item.nombre = String(getValueByPossibleKeys(['nombre', 'articulo', 'articulo', 'name', 'desc', 'descripcion', 'descripcion'])).trim();
        item.bodega = String(getValueByPossibleKeys(['bodega', 'almacen', 'almacen', 'warehouse'])).trim();
        
        // Costo (numérico)
        const costVal = getValueByPossibleKeys(['costo', 'cost', 'precio', 'price', 'valor', 'value']);
        item.costo = isNaN(parseFloat(costVal)) ? 0 : parseFloat(costVal);

        // Existencia (numérica)
        const existVal = getValueByPossibleKeys(['existencia', 'existencias', 'stock', 'cant', 'cantidad', 'qty']);
        item.existencia = isNaN(parseFloat(existVal)) ? 0 : parseFloat(existVal);
        
        // Contado (ver si ya tiene conteos previos cargados)
        const countedVal = getValueByPossibleKeys(['contado', 'conteo', 'counted']);
        if (countedVal !== "" && !isNaN(parseFloat(countedVal))) {
            item.contado = parseFloat(countedVal);
            item.partialCounts = [{ id: Date.now(), qty: item.contado, desc: 'Cargado de Excel' }];
        } else {
            item.contado = null; // null significa no contado aún
            item.partialCounts = [];
        }
        
        // Diferencia
        item.diferencias = item.contado !== null ? (item.contado - item.existencia) : null;
        
        return item;
    }).filter(item => item.codigo !== "" || item.nombre !== ""); // Filtrar filas vacías
}

// ----------------------------------------------------
// 3. PERSISTENCIA DE DATOS (LOCALSTORAGE)
// ----------------------------------------------------
function saveToLocalStorage() {
    try {
        localStorage.setItem('antigravity_inventory', JSON.stringify(inventory));
        localStorage.setItem('antigravity_filename', fileName);
        setStatus('saved', 'Guardado en Navegador');
    } catch (e) {
        console.error("No se pudo guardar en LocalStorage (tal vez excedió cuota):", e);
    }
}

function loadFromLocalStorage() {
    const savedInventory = localStorage.getItem('antigravity_inventory');
    const savedFileName = localStorage.getItem('antigravity_filename');
    
    if (savedInventory) {
        try {
            inventory = JSON.parse(savedInventory);
            fileName = savedFileName || 'inventario.xlsx';
            showDashboard();
        } catch (e) {
            console.error("Error al leer de LocalStorage:", e);
            localStorage.clear();
            showUploadView();
        }
    } else {
        showUploadView();
    }
}

// ----------------------------------------------------
// 4. CONTROL DE PANTALLAS (VISTAS)
// ----------------------------------------------------
function showUploadView() {
    DOM.uploadView.classList.add('active-view');
    DOM.dashboardView.classList.remove('active-view');
    setStatus('offline', 'Sin Archivo');
}

function showDashboard() {
    DOM.uploadView.classList.remove('active-view');
    DOM.dashboardView.classList.add('active-view');
    DOM.loadedFileName.textContent = fileName;
    
    setStatus('online', 'Catálogo Activo');
    updateStats();
    renderList();
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
    const diff = inventory.filter(item => item.contado !== null && item.diferencias !== 0).length;
    
    // Actualizar números de Dashboard
    DOM.statTotal.textContent = total;
    DOM.statCounted.textContent = counted;
    DOM.statPending.textContent = pending;
    DOM.statDiff.textContent = diff;
    
    // Porcentaje
    const pct = total > 0 ? Math.round((counted / total) * 100) : 0;
    DOM.statCountedPct.textContent = `${pct}% del total`;
    
    // Badges en las pestañas
    DOM.badgeAll.textContent = total;
    DOM.badgePending.textContent = pending;
    DOM.badgeCounted.textContent = counted;
    DOM.badgeDiff.textContent = diff;
}

// ----------------------------------------------------
// 6. BUSCADOR Y RENDERIZADO DE ELEMENTOS
// ----------------------------------------------------
function handleSearch() {
    searchQuery = DOM.searchInput.value.trim().toLowerCase();
    
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
        if (currentFilter === 'diff' && (item.contado === null || item.diferencias === 0)) return false;
        
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
    if (filteredItems.length === 0) {
        DOM.emptyResultsState.style.display = 'flex';
        return;
    } else {
        DOM.emptyResultsState.style.display = 'none';
    }
    
    // 2. Renderizar filas y tarjetas
    filteredItems.forEach(item => {
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
    if (item.contado === null) {
        tr.className = 'row-not-counted';
    } else if (item.diferencias === 0) {
        tr.className = 'row-counted-no-diff';
    } else {
        tr.className = 'row-counted-diff';
    }
    
    // Datos formateados
    const contadoStr = item.contado !== null ? item.contado : '-';
    let diffStr = '-';
    let diffClass = '';
    
    if (item.contado !== null) {
        diffStr = item.diferencias;
        if (item.diferencias > 0) {
            diffStr = `+${item.diferencias}`;
            diffClass = 'val-success';
        } else if (item.diferencias < 0) {
            diffClass = 'val-danger';
        } else {
            diffClass = 'val-muted';
        }
    }
    
    tr.innerHTML = `
        <td><strong>${item.codigo}</strong></td>
        <td>${item.alterno || '<span class="val-muted">-</span>'}</td>
        <td>${item.nombre}</td>
        <td><span class="card-wh-badge">${item.bodega || 'N/D'}</span></td>
        <td class="num-col">$${item.costo.toFixed(2)}</td>
        <td class="num-col"><strong>${item.existencia}</strong></td>
        <td class="num-col font-weight-bold" style="font-size:1.05rem;">${contadoStr}</td>
        <td class="num-col ${diffClass}"><strong>${diffStr}</strong></td>
        <td class="action-col">
            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openCountingModalById(${item.id})">
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
    
    let borderClass = 'row-not-counted';
    if (item.contado !== null) {
        borderClass = item.diferencias === 0 ? 'row-counted-no-diff' : 'row-counted-diff';
    }
    
    card.className = `card item-card ${borderClass}`;
    
    const contadoStr = item.contado !== null ? item.contado : '-';
    let diffStr = '-';
    let diffClass = 'val-muted';
    
    if (item.contado !== null) {
        diffStr = item.diferencias;
        if (item.diferencias > 0) {
            diffStr = `+${item.diferencias}`;
            diffClass = 'val-success';
        } else if (item.diferencias < 0) {
            diffClass = 'val-danger';
        } else {
            diffClass = 'val-muted';
        }
    }
    
    card.innerHTML = `
        <div class="card-header-row">
            <div class="card-code-section">
                <span class="card-code">${item.codigo}</span>
                <span class="card-alt">${item.alterno ? 'Alt: ' + item.alterno : 'Sin alterno'}</span>
            </div>
            <div>
                ${item.contado !== null ? 
                  `<span class="col-tag-status ${item.diferencias === 0 ? 'col-tag-success' : 'col-tag-warning'}">
                    ${item.diferencias === 0 ? 'Ok' : 'Diferencia'}
                   </span>` : 
                  '<span class="col-tag-status col-tag-muted">Pendiente</span>'
                }
            </div>
        </div>
        <div class="card-name">${item.nombre}</div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <span class="card-wh-badge">${item.bodega || 'Bodega: N/D'}</span>
            <span class="card-wh-badge" style="background-color: rgba(59, 130, 246, 0.05); color: var(--primary); border-color: rgba(59, 130, 246, 0.15);">Costo: $${item.costo.toFixed(2)}</span>
        </div>
        <div class="card-stocks-row">
            <div class="card-stock-item">
                <span class="card-stock-label">Exist.</span>
                <span class="card-stock-val">${item.existencia}</span>
            </div>
            <div class="card-stock-item" style="border-left: 1px solid var(--border-color); border-right: 1px solid var(--border-color);">
                <span class="card-stock-label">Contado</span>
                <span class="card-stock-val" style="font-size:1.1rem; color:var(--primary);">${contadoStr}</span>
            </div>
            <div class="card-stock-item">
                <span class="card-stock-label">Dif.</span>
                <span class="card-stock-val ${diffClass}">${diffStr}</span>
            </div>
        </div>
    `;
    
    card.addEventListener('click', () => openCountingModal(item));
    
    return card;
}

// Helper para abrir el modal desde un onclick en código inline
window.openCountingModalById = function(id) {
    const item = inventory.find(i => i.id === id);
    if (item) openCountingModal(item);
};

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
    DOM.modalArticleWh.textContent = selectedItem.bodega || 'N/D';
    DOM.modalArticleCost.textContent = `$${selectedItem.costo.toFixed(2)}`;
    DOM.modalArticleExist.textContent = selectedItem.existencia;
    
    // Inicializar campo de expresión (fórmula / número directo)
    DOM.countExpression.value = '';
    DOM.expressionPreview.style.display = 'none';
    
    // Cargar historial de parciales
    renderPartialList();
    
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
    
    try {
        // Como hemos restringido estrictamente los caracteres a matemáticas básicas,
        // evaluar con un constructor Function es seguro y robusto en este contexto de navegador.
        const val = new Function(`return (${str})`)();
        return typeof val === 'number' && !isNaN(val) ? val : NaN;
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
        } else {
            DOM.expressionPreview.textContent = `= ${exprParsed}`;
            DOM.expressionPreview.style.color = 'var(--success)';
            DOM.expressionPreview.style.display = 'block';
        }
    } else {
        DOM.expressionPreview.style.display = 'none';
        if (isNaN(exprParsed)) exprParsed = 0;
    }
    
    // Sumar con el historial de parciales
    const partialsSum = (selectedItem.partialCounts || []).reduce((acc, p) => acc + p.qty, 0);
    const totalCounted = exprParsed + partialsSum;
    
    // Guardar conteo momentáneo en el clon
    selectedItem.contado = totalCounted;
    selectedItem.diferencias = selectedItem.contado - selectedItem.existencia;
    
    // Actualizar UI del modal
    DOM.summaryTotalCounted.textContent = selectedItem.contado;
    
    let diffStr = selectedItem.diferencias;
    if (selectedItem.diferencias > 0) {
        diffStr = `+${selectedItem.diferencias}`;
        DOM.summaryDifference.className = 'summary-value val-success';
    } else if (selectedItem.diferencias < 0) {
        DOM.summaryDifference.className = 'summary-value val-danger';
    } else {
        DOM.summaryDifference.className = 'summary-value val-muted';
    }
    DOM.summaryDifference.textContent = diffStr;
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

// Agrega una cantidad parcial al listado acumulativo
function addPartialCount() {
    if (!selectedItem) return;
    
    const qty = parseFloat(DOM.partialQty.value);
    const desc = DOM.partialDesc.value.trim();
    
    if (isNaN(qty) || qty <= 0) {
        alert("Ingrese una cantidad válida y mayor a 0 para acumular.");
        DOM.partialQty.focus();
        return;
    }
    
    const partial = {
        id: Date.now(),
        qty: qty,
        desc: desc || `Parcial ${selectedItem.partialCounts.length + 1}`
    };
    
    selectedItem.partialCounts.push(partial);
    
    // Limpiar inputs del formulario parcial
    DOM.partialQty.value = '';
    DOM.partialDesc.value = '';
    
    renderPartialList();
    calculateModalTotal();
    
    DOM.partialQty.focus(); // mantener el foco en la cantidad para registrar otro rápido
}

function deletePartialCount(id) {
    if (!selectedItem) return;
    
    selectedItem.partialCounts = selectedItem.partialCounts.filter(p => p.id !== id);
    renderPartialList();
    calculateModalTotal();
}

// Inyecta el historial acumulado en el modal
function renderPartialList() {
    DOM.partialList.innerHTML = '';
    const partials = selectedItem.partialCounts || [];
    
    if (partials.length === 0) {
        DOM.partialEmpty.style.display = 'block';
        return;
    }
    
    DOM.partialEmpty.style.display = 'none';
    
    partials.forEach(p => {
        const li = document.createElement('li');
        li.className = 'partial-item';
        li.innerHTML = `
            <div>
                <span class="partial-item-val">${p.qty}</span>
                <span class="partial-item-desc">${p.desc}</span>
            </div>
            <button class="btn-delete-partial" onclick="event.stopPropagation(); deletePartialCountById(${p.id})">&times;</button>
        `;
        DOM.partialList.appendChild(li);
    });
}

// Helper global para invocar la eliminación desde el onclick del HTML
window.deletePartialCountById = function(id) {
    deletePartialCount(id);
};

// Guarda los datos del clon en el arreglo principal de inventario
function saveCount() {
    if (!selectedItem) return;
    
    // Si el usuario tiene una expresión incompleta o no procesada en el input principal,
    // se sumará antes de guardar.
    calculateModalTotal();
    
    // Buscar y actualizar el artículo real en el array
    const realIndex = inventory.findIndex(item => item.id === selectedItem.id);
    if (realIndex !== -1) {
        // Si no ingresó nada en expresión ni tiene parciales, mantener en pendiente (null)
        // a menos que explícitamente se presione guardar en 0.
        // Pero si escribió algo o hay parciales, registramos el conteo.
        const hasInput = DOM.countExpression.value.trim() !== '';
        const hasPartials = selectedItem.partialCounts.length > 0;
        
        if (!hasInput && !hasPartials && selectedItem.contado === 0) {
            // Guardar como no contado (pendiente) si todo está en blanco
            inventory[realIndex].contado = null;
            inventory[realIndex].diferencias = null;
            inventory[realIndex].partialCounts = [];
        } else {
            inventory[realIndex].contado = selectedItem.contado;
            inventory[realIndex].diferencias = selectedItem.diferencias;
            inventory[realIndex].partialCounts = selectedItem.partialCounts;
        }
        
        saveToLocalStorage();
        updateStats();
        renderList();
    }
    
    closeCountingModal();
}

// ----------------------------------------------------
// 8. ACCIONES: LIMPIAR, NUEVO Y PLANTILLA EXCEL
// ----------------------------------------------------
function confirmClearCounts() {
    if (confirm("¿Está seguro de que desea limpiar todos los conteos registrados? Esta acción no se puede deshacer.")) {
        inventory.forEach(item => {
            item.contado = null;
            item.diferencias = null;
            item.partialCounts = [];
        });
        saveToLocalStorage();
        updateStats();
        renderList();
    }
}

function confirmLoadNewFile() {
    if (confirm("¿Desea cargar un nuevo archivo? Asegúrese de haber descargado los resultados actuales antes de continuar.")) {
        localStorage.removeItem('antigravity_inventory');
        localStorage.removeItem('antigravity_filename');
        inventory = [];
        fileName = 'inventario.xlsx';
        DOM.excelFileInput.value = '';
        showUploadView();
    }
}

// Genera un archivo Excel vacío de ejemplo (Plantilla)
function downloadTemplate() {
    const templateData = [
        {
            "codigo": "ART001",
            "alterno": "ALT101",
            "nombre": "TORNILLO ACERO 1/2 PULGADA",
            "bodega": "Bodega Principal",
            "costo": 0.15,
            "existencia": 150
        },
        {
            "codigo": "ART002",
            "alterno": "",
            "nombre": "TUERCA ZINCADA 1/2 PULGADA",
            "bodega": "Bodega Principal",
            "costo": 0.08,
            "existencia": 200
        },
        {
            "codigo": "ART003",
            "alterno": "ALT103",
            "nombre": "ARANDELA PRESION 1/2 PULGADA",
            "bodega": "Bodega Sucursal",
            "costo": 0.05,
            "existencia": 50
        }
    ];

    const worksheet = XLSX.utils.json_to_sheet(templateData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Plantilla Inventario");
    
    // Auto-ajuste de columnas básico
    worksheet["!cols"] = [
        { wch: 12 }, // codigo
        { wch: 12 }, // alterno
        { wch: 35 }, // nombre
        { wch: 18 }, // bodega
        { wch: 10 }, // costo
        { wch: 12 }  // existencia
    ];

    XLSX.writeFile(workbook, "plantilla_inventario.xlsx");
}

// Exporta el inventario con los conteos y diferencias a un nuevo Excel
function downloadResults() {
    if (inventory.length === 0) {
        alert("No hay datos para descargar.");
        return;
    }
    
    // Estructurar los datos exactos que requiere el usuario
    const exportData = inventory.map(item => ({
        "codigo": item.codigo,
        "alterno": item.alterno,
        "nombre": item.nombre,
        "bodega": item.bodega,
        "costo": item.costo,
        "existencia": item.existencia,
        "contado": item.contado !== null ? item.contado : "",
        "diferencias": item.diferencias !== null ? item.diferencias : ""
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Resultados Inventario");
    
    // Auto-ajustar anchos de columnas
    worksheet["!cols"] = [
        { wch: 14 }, // codigo
        { wch: 14 }, // alterno
        { wch: 40 }, // nombre
        { wch: 20 }, // bodega
        { wch: 10 }, // costo
        { wch: 12 }, // existencia
        { wch: 12 }, // contado
        { wch: 12 }  // diferencias
    ];

    // Obtener fecha actual para el nombre del archivo
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
    const finalFileName = `conteo_inventario_${dateStr}_${timeStr}.xlsx`;

    XLSX.writeFile(workbook, finalFileName);
    
    setStatus('saved', 'Resultados Descargados');
}

// ----------------------------------------------------
// 9. EVENTOS DE INICIO
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', init);
