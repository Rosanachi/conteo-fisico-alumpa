# Imágenes de catálogo en Artículos: diseño

Estado: diseño y código de referencia sin ejecutar. Faltan el PDF del catálogo y el listado de artículos (ver "Incidencias").

## 1. Arquitectura

App actual: PWA estática (index.html, app.js, sw.js), sin backend. El inventario vive en `localStorage` (cargado desde Excel). CSP: `img-src 'self' data:`.

```
PDF catálogo ──(build offline: extract_catalog.py)──► /catalog/img/*.webp
                                                    ► /catalog/index.json   (key4 -> [entradas])
                                                    ► /catalog/report.csv   (huérfanas, duplicados)
Excel artículos ─► app.js (mapExcelData / crearArticulo) ─► matchImagen(alterno)
Búsqueda ─► renderList ─► <img src=/catalog/img/..> (lazy) ─► SW cache-first ─► fallback SVG
```

Decisiones:
- La extracción corre offline (Python). La app solo consume archivos estáticos. No se parsea el PDF en el navegador.
- Imágenes como archivos en `/catalog/img/`, no en `localStorage` (cuota ~5 MB) ni como base64. Se sirven desde el mismo origen, así que la CSP no cambia.
- La clave de cruce es `key4`. Como 4 dígitos dan solo 10 000 claves, se esperan colisiones. El índice guarda una lista por `key4` y el matching nunca asigna en silencio si hay más de un candidato.

## 2. Modelo de datos

`catalog/index.json` (generado):
```json
{
  "version": "2025-01-01T00:00:00Z",
  "pdf_sha256": "…",
  "items": {
    "1234": [
      { "code": "AB-001234", "file": "img/AB-001234.webp", "page": 7,
        "w": 400, "h": 400, "sha256": "…", "conf": "high" }
    ]
  }
}
```
- `key4`: últimos 4 caracteres del código PDF, tal cual (string, conserva ceros a la izquierda).
- `conf`: `high` si la imagen se asoció al código por proximidad y es única en su bloque; `low` si hubo varias imágenes candidatas.

Campos nuevos en el artículo (en el objeto del inventario):
```
imgKey4:   string|null      primeros 4 de Alterno normalizado
imgCode:   string|null      código PDF elegido
imgState:  'matched'|'ambiguous'|'none'|'manual'
imgCands:  string[]         códigos candidatos cuando es 'ambiguous'
```
`manual` no se sobrescribe nunca por un re-matching automático.

## 3. Extractor (Python, PyMuPDF)

Dependencias: `pip install pymupdf pillow`.

```python
# extract_catalog.py
import fitz, re, json, hashlib, csv, sys, pathlib
from PIL import Image
import io

PDF, OUT = sys.argv[1], pathlib.Path(sys.argv[2])
CODE_RE = re.compile(r'\b[A-Z0-9][A-Z0-9\-\.\/]{3,}\b')   # AJUSTAR al formato real de códigos
MIN_PX = 80                                                 # descarta logos/iconos

(OUT/'img').mkdir(parents=True, exist_ok=True)
doc = fitz.open(PDF)
items, report, seen_hash = {}, [], {}

def safe(code): return re.sub(r'[^A-Za-z0-9_.-]', '_', code)

for pno, page in enumerate(doc, 1):
    words = page.get_text('words')                          # x0,y0,x1,y1,text,...
    codes = [(fitz.Rect(w[:4]), w[4]) for w in words if CODE_RE.fullmatch(w[4])]
    for img in page.get_images(full=True):
        xref = img[0]
        for rect in page.get_image_rects(xref):
            if rect.width < 30 or rect.height < 30: continue
            pix = fitz.Pixmap(doc, xref)
            if pix.n - pix.alpha >= 4: pix = fitz.Pixmap(fitz.csRGB, pix)
            im = Image.open(io.BytesIO(pix.tobytes('png')))
            if min(im.size) < MIN_PX: continue
            # código más cercano (debajo o a la derecha de la imagen)
            def dist(c):
                r = c[0]; dx = max(r.x0 - rect.x1, rect.x0 - r.x1, 0)
                dy = max(r.y0 - rect.y1, rect.y0 - r.y1, 0)
                return (dx*dx + dy*dy) ** .5
            if not codes: report.append((pno, '', 'imagen sin códigos en página')); continue
            ranked = sorted(codes, key=dist)
            code = ranked[0][1]
            conf = 'high' if len(ranked) == 1 or dist(ranked[1]) > 1.5*dist(ranked[0]) else 'low'
            im.thumbnail((600, 600))
            buf = io.BytesIO(); im.convert('RGB').save(buf, 'WEBP', quality=80)
            h = hashlib.sha256(buf.getvalue()).hexdigest()
            fn = f'img/{safe(code)}.webp'
            (OUT/fn).write_bytes(buf.getvalue())
            if len(code) < 4: report.append((pno, code, 'código < 4 caracteres')); continue
            key4 = code[-4:]
            items.setdefault(key4, []).append(
                dict(code=code, file=fn, page=pno, w=im.width, h=im.height, sha256=h, conf=conf))

for k, v in items.items():
    if len({e['code'] for e in v}) > 1:
        report.append(('', k, f'colisión key4: {[e["code"] for e in v]}'))
    codes_seen = [e['code'] for e in v]
    for c in set(codes_seen):
        if codes_seen.count(c) > 1: report.append(('', c, 'código con varias imágenes'))

json.dump(dict(pdf_sha256=hashlib.sha256(open(PDF,'rb').read()).hexdigest(), items=items),
          open(OUT/'index.json', 'w'), ensure_ascii=False)
csv.writer(open(OUT/'report.csv', 'w', newline='', encoding='utf-8')).writerows(
    [('pagina', 'codigo/key', 'incidencia'), *report])
```
Si el PDF trae el código como parte de la imagen (escaneado), no hay capa de texto: hace falta OCR (Tesseract) y el campo `conf` baja a `low`.

## 4. Función de matching (JS, app.js)

```js
const IMG = { index: null };

async function loadCatalogIndex() {
  try {
    const r = await fetch('catalog/index.json', { cache: 'no-cache' });
    IMG.index = (await r.json()).items;
  } catch { IMG.index = {}; }           // sin índice: todo cae al fallback
}

function key4FromAlterno(alt) {
  const s = String(alt ?? '').trim().replace(/\s+/g, '');
  return s.length >= 4 ? s.slice(0, 4) : null;      // string, no número: conserva ceros
}

// Devuelve { state, key4, code, cands }
function matchImagen(alterno) {
  const key4 = key4FromAlterno(alterno);
  if (!key4) return { state: 'none', key4: null, code: null, cands: [] };
  const list = IMG.index?.[key4] ?? [];
  const codes = [...new Set(list.map(e => e.code))];
  if (codes.length === 0) return { state: 'none', key4, code: null, cands: [] };
  if (codes.length === 1) return { state: 'matched', key4, code: codes[0], cands: [] };
  return { state: 'ambiguous', key4, code: null, cands: codes };
}

function imageUrlFor(item) {
  const code = item.imgCode;
  const e = code && IMG.index?.[item.imgKey4]?.find(x => x.code === code);
  return e ? 'catalog/' + e.file : null;
}
```
Comparación: se usa igualdad exacta de strings, con mayúsculas/minúsculas normalizadas si el código lleva letras (`toUpperCase()` en ambos lados).

## 5. Búsqueda con imagen

La búsqueda actual filtra en memoria (`renderList`, líneas ~514-560 de app.js). La imagen no cambia la consulta, solo el render:

```js
function thumbHtml(item) {
  const url = imageUrlFor(item);
  if (!url) return `<span class="thumb thumb--empty" aria-label="Sin imagen"></span>`;
  return `<img class="thumb" src="${url}" loading="lazy" decoding="async" width="56" height="56"
            alt="${escapeHtml(item.nombre ?? '')}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'thumb thumb--empty'}))">`;
}
```
Nota: la CSP prohíbe `onerror` inline si se endurece `script-src`. Con `script-src 'self'` actual los atributos inline ya están bloqueados. Usar un listener delegado: `list.addEventListener('error', e => { if (e.target.matches('img.thumb')) e.target.classList.add('thumb--empty'); }, true)`.

Resolución de `imgCode` por artículo: se calcula una vez al cargar el Excel o crear el artículo y se guarda en el objeto. En la búsqueda solo se lee el campo (O(1) por fila). Para artículos con `imgState === 'ambiguous'` se muestra un icono de aviso y en el modal el selector de candidatos (guarda `manual`).

Modal de detalle: misma imagen en tamaño grande (`catalog/img/<code>.webp`, máx. 600 px).

## 6. Caché

- Service worker: cache aparte `inventario-img-v1`, estrategia cache-first para `/catalog/img/*`, límite por LRU (p. ej. 300 entradas). Una imagen se identifica por el nombre del archivo, que incluye el código. Si el PDF cambia, se sube `version` en el índice y se cambia el nombre de caché.
- `catalog/index.json`: network-first (como el resto de assets), con copia en caché para uso sin conexión.
- No incluir las imágenes en `ASSETS` de `install`: sería una descarga masiva. Se cachean bajo demanda.
- `vercel.json`: añadir `Cache-Control: public, max-age=31536000, immutable` para `/catalog/img/(.*)`, y `no-cache` para `/catalog/index.json`.
- Cuidado: `activate` borra todo cache distinto de `CACHE_NAME`. Hay que añadir `inventario-img-v1` a la lista de caches a conservar, o se borrarán las imágenes en cada versión.

## 7. Hook de creación de artículo

La app hoy no crea artículos a mano: solo carga Excel (`mapExcelData`, app.js ~349). Hay dos puntos de enganche:

```js
// Punto único: aplicar a cada artículo nuevo, venga del Excel o de un formulario futuro.
function asignarImagenAutomatica(item) {
  if (item.imgState === 'manual') return item;          // nunca pisar una elección manual
  const m = matchImagen(item.alterno);
  item.imgKey4 = m.key4;
  item.imgCode = m.code;
  item.imgState = m.state;
  item.imgCands = m.cands;
  return item;
}

// En mapExcelData, tras construir cada item:
//   inventory = rows.map(r => asignarImagenAutomatica(buildItem(r)));
// En un futuro crearArticulo(data):
//   const item = asignarImagenAutomatica({ ...data, id: crypto.randomUUID() });
//   inventory.push(item); saveToLocalStorage();
```
Comportamiento por caso:
| Caso | Resultado |
|---|---|
| Alterno vacío o < 4 caracteres | `none`, sin imagen, sin error |
| 0 candidatos | `none`, placeholder; el artículo se crea igual |
| 1 candidato | `matched`, imagen asignada |
| ≥ 2 candidatos | `ambiguous`, sin imagen automática; el usuario elige y pasa a `manual` |
| Índice no cargado | `none` temporal. Se reintenta con `reMatchAll()` al cargar el índice |

Cuando cambie `index.json` (nuevo catálogo), `reMatchAll()` recorre el inventario y reaplica `asignarImagenAutomatica` sobre los que no sean `manual`. Para que no aumente el peso de `localStorage`, los campos añadidos son cadenas cortas.

## 8. Plan de pruebas

Unitarias (`matchImagen`, `key4FromAlterno`):
1. Alterno `"1234ABC"` y código `"X-9991234"` → `matched`.
2. Alterno `"0123"` con código `"…0123"` → conserva ceros.
3. Alterno `"123"`, `""`, `null`, `"  "` → `none` sin excepción.
4. Alterno con espacios `" 12 34 "` → `"1234"`.
5. Dos códigos con los mismos últimos 4 → `ambiguous`, lista de candidatos.
6. Mayúsculas/minúsculas en códigos alfanuméricos.
7. `imgState: 'manual'` sobrevive a `reMatchAll()`.

Extractor:
8. PDF de muestra de 3 páginas con 2 imágenes y 2 códigos: cada imagen se asocia al código más cercano.
9. Logo y fondos (< 80 px) se descartan.
10. Misma imagen reutilizada en dos páginas: dos entradas, un hash igual (informativo).
11. Página sin códigos: va al `report.csv`.
12. PDF escaneado: el reporte indica que no hay capa de texto.

Integración (navegador):
13. Buscar por nombre, alterno y código: se ve la miniatura, sin romper el filtro.
14. Imagen 404: aparece el placeholder, sin icono roto.
15. Sin conexión: segunda visita muestra imágenes ya vistas; las no vistas muestran placeholder.
16. Cargar Excel de 10 000 filas: tiempo de carga y `localStorage` dentro de cuota (verificar el peso añadido).
17. Lista con scroll: solo se descargan las imágenes visibles (`loading="lazy"`).
18. Cambio de versión del SW: las imágenes cacheadas no se borran.

Cruce (con los datos reales): contar artículos por estado, revisar a mano una muestra de 30 `matched` (abrir imagen y verificar que corresponde al nombre).

## 9. Tabla de cruce (plantilla)

Se genera con `cruce.py` o con un script en Node una vez existan los dos archivos. Columnas:

| Alterno | key4 (alterno[:4]) | Código PDF | key4 (código[-4:]) | Archivo imagen | Estado | Candidatos |
|---|---|---|---|---|---|---|
| (pendiente) | | | | | | |

Más tres listas: artículos sin imagen, imágenes del catálogo sin artículo, y claves con colisión.

## 10. Incidencias

1. **No existe en el workspace el PDF del catálogo.** Busqué en `E:\KIRO`, Escritorio, Descargas y Documentos y no encontré ningún `.pdf`. Por eso no hay imágenes extraídas, índice ni tabla de cruce real.
2. **No existe el listado de artículos.** El workspace no incluye ningún Excel con la columna Alterno. Solo hay una plantilla de ejemplo en `app.js` (`ALT101`, vacío, `ALT103`). El archivo `Plantilla_Articulos.xlsx` del Escritorio es de otro proyecto y no lo usé.
3. **Python no está instalado** en esta máquina (el comando `python` lleva a la Microsoft Store). El extractor requiere Python 3 o una versión equivalente en Node (`pdfjs-dist` + `sharp`).
4. **La app no tiene alta manual de artículos.** El hook se engancha en la carga de Excel y queda listo para un formulario futuro.
5. **Riesgo de colisiones:** 4 caracteres permiten pocas claves. Con un catálogo de cientos de códigos es probable que haya duplicados de `key4`, y que una regla de solo 4 dígitos asocie imágenes equivocadas. Propongo validar con la lista real y, si hay muchas colisiones, añadir un segundo criterio (por ejemplo, prefijo o descripción).
6. **Formato del código PDF desconocido:** la expresión regular `CODE_RE` es un supuesto y se debe ajustar con una muestra real.
7. **Códigos alfanuméricos y ceros:** tratar `key4` siempre como texto. Excel puede convertir alternos numéricos a número y perder ceros a la izquierda; `mapExcelData` ya hace `String(...)`, pero el cero ya perdido en el Excel no se puede recuperar.
8. **Service worker:** el `activate` actual borra cualquier caché que no sea la versión vigente. Hay que ajustarlo (ver sección 6).
9. **Derechos de las imágenes:** confirmar que se pueden publicar. Vercel serviría el catálogo de forma pública.

---

## 11. Resultados con los datos reales (actualiza las secciones 3, 4 y 10)

Archivos: `datos/Catalogo ALDECA 2024.pdf` (499 páginas, 21 MB) y `datos/articulosaluminio.xlsx` (2125 artículos; columnas Codigo, alterno, descripcion).

**Hallazgos que cambian el diseño original**
- El PDF no tiene fotos. Tiene solo 2 imágenes ráster (portada). Los perfiles son dibujos vectoriales, así que el extractor renderiza la página y recorta cada dibujo. Lo hace con `mupdf` (WASM) y `sharp`, en Node, sin Python.
- Los códigos del catálogo son `AL-<número>` con 3 o 4 dígitos (`AL-735`, `AL-3040`). Para que "últimos 4" coincida con el alterno (`0735FA61`), el número se rellena con ceros a 4 dígitos: `AL-735` -> `0735`. Sin ese relleno solo coincidiría el ~80 % de los códigos de 4 dígitos.
- `AL-092` y `AL-0092` son el mismo dado escrito de dos formas. El extractor normaliza con `parseInt`, y con eso desaparecen las colisiones falsas.
- El alterno trae espacios al final (`'0735FA61            '`). Se aplica `trim`.
- Hay 3 tipos de página: dibujos con etiqueta `AL-xxx` dentro o junto al dibujo (recorte propio por código), páginas con un dibujo genérico y una tabla de dados (un recorte compartido por los códigos de la tabla), y páginas con ensamblajes.

Función de clave final:
```js
const keyFromPdfCode = c => String(parseInt(c.replace(/\D/g,''),10)).slice(-4).padStart(4,'0');
const keyFromAlterno = a => { const k = String(a).trim().slice(0,4); return /^\d{4}$/.test(k) ? k : null; };
```

**Extracción:** 1791 códigos únicos del catálogo con imagen, 1705 archivos `.webp` (5,2 MB en total, máx. 480 px). Salida en `catalog/img/`, `catalog/index.json`.

| Confianza de la imagen | Códigos | Significado |
|---|---|---|
| high | 1264 | Recorte propio del perfil, con su etiqueta dentro o junto al dibujo |
| medium | 291 | La etiqueta quedó en un recorte con otros perfiles; revisar |
| shared | 236 | El código solo aparece en la tabla; se usa el dibujo genérico de la página |

Páginas sin dibujo detectado (6): 107, 108, 109, 110, 306, 456.

**Cruce (alterno[:4] = código PDF[-4:] rellenado a 4):** `datos/tabla_cruce.xlsx` (hojas Cruce, Sin_match, Ambiguos, PDF_sin_articulo, Colisiones_PDF).

| Estado | Artículos | % |
|---|---|---|
| matched | 1985 | 93,4 % |
| none (alterno numérico sin código en el PDF) | 94 | 4,4 % |
| alterno_no_numerico (`PAGEN`, `PB50BL`, `PB54CH`...) | 46 | 2,2 % |
| ambiguous | 0 | 0 % |
| Total | 2125 | |

De los 1985 con match, 1236 tienen imagen `high`, 274 `medium` y 475 `shared`. Hay 529 alternos distintos de 4 caracteres; 50 no tienen código en el PDF. Quedan 1312 códigos del catálogo sin artículo en el listado.

**Incidencias reales**
1. 94 artículos sin código en el PDF. Ejemplos: claves 2426-2432 (vitrinas), 2327, 2463, 2501, 2578. El catálogo 2024 no los incluye. Se muestran con el placeholder.
2. 46 artículos con alterno no numérico (`PAGEN`, `PB50...`, `PB54...`). La regla no se les puede aplicar. Necesitan una asignación manual.
3. `PAAPV02478*` tiene alterno `2428..` y código `02478`. El alterno no sigue el código del artículo, pero la regla pedida usa el alterno y se respeta.
4. Un código de artículo con alterno `0897MA` pero código `PAANG00897NOG01` indica que el alterno se mantiene por familia. Varios artículos (acabados) comparten una misma imagen por diseño.
5. Los recortes `medium` y `shared` (cerca de 500 códigos) pueden mostrar un dibujo de varios perfiles. Revisar una muestra.
6. Páginas sin dibujo (6) y la cota del borde derecho que a veces queda cortada por pocos píxeles.
7. Derechos del catálogo ALDECA: confirmar que se pueden publicar las imágenes en Vercel.

**Scripts** (fuera de la carpeta de la app para que Vercel no suba `node_modules`): `E:\KIRO\tools-conteo\extract.mjs` (genera `catalog/`) y `cruce.mjs` (genera `tabla_cruce.xlsx`). Reejecutar: `cd E:\KIRO\tools-conteo; node extract.mjs; node cruce.mjs`.
