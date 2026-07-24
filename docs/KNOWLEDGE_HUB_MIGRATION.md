# Knowledge Hub — Plan de evolución

Tres líneas de trabajo independientes. Cada una puede avanzar sin esperar a las demás.

---

## 1. Knowledge Hub — Correcciones y modularización

Objetivo: corregir los defectos de seguridad detectados en la auditoría y dividir el monolito `index.html` (541 KB, 4 274 líneas) en archivos separados.

### 1.1 Defectos de seguridad (bloqueantes)

| # | Defecto | Estado | Commit |
|---|---------|--------|--------|
| S-1 | 47 `innerHTML` con datos de Notion sin sanitizar (XSS almacenado) | **Resuelto** | `f30fe69` + `2766755` + `ec648fc` |
| S-2 | Sin Content-Security-Policy | **Resuelto** | `504be37` |
| S-3 | 51 `onclick` inline — migrados a `addEventListener` delegation | **Resuelto** | `beada7e` |
| S-4 | Workflow push directo a main — ahora usa `create-pull-request` | **Resuelto** | `9803335` |
| S-5 | Auto-descarga `outerHTML` — ahora fetch del archivo original | **Resuelto** | `9803335` |

S-1 y S-2 deben resolverse antes de publicar. S-3 a S-5 pueden ir en commits separados.

### 1.2 Valores estáticos desacoplados

El HTML contiene valores hardcodeados que se actualizan con JavaScript después de cargar el JSON, provocando un flash de dato incorrecto:

| Elemento | Valor estático actual | Valor real (DATA) | Se actualiza en JS |
|----------|----------------------|--------------------|--------------------|
| `#nc-total` (sidebar) | 236 | 331 | Sí, `initCounts()` |
| `#h-total` (home) | 244 | 331 | Sí, `initCounts()` |
| `#exp-total` (explore) | 244 | 331 | Sí, `initCounts()` |
| `#result-count` | "236 de 236 entradas" | — | Sí, `renderTable()` |
| `#table-foot-count` | "236 resultados" | — | Sí, `renderTable()` |
| `#nc-ciber` / `#nc-tech` / `#nc-cripto` | 47 / 83 / 106 | — | Sí, `initCounts()` |
| `SYSTEM_STATE.total` | 244 | 331 | Nunca |
| `SYSTEM_STATE.dbs[*].count` | Varios | — | Nunca |
| `resolvedCount` (L4069) | 325 (hardcodeado) | — | Nunca |

Solución: los elementos HTML nacen vacíos o con un placeholder de carga (`—`). Los conteos se calculan siempre desde DATA. `SYSTEM_STATE` se elimina o se genera automáticamente en `sync-notion.mjs`.

### 1.3 Modularización

Estructura propuesta, siguiendo las responsabilidades reales de la aplicación:

```
index.html                  ← shell: <head> con CSP, sidebar, topbar, contenedores <div class="view">
css/
  tokens.css                ← custom properties (colores, radii, tipografía)
  layout.css                ← sidebar, main, topbar, responsive
  components.css            ← cards, pills, badges, tablas, formularios
  views.css                 ← estilos de intelligence, investigations, integrity
js/
  sanitize.js               ← escapeHTML() y sanitizeRichText()
  data.js                   ← DB_META, AREA_META, AREA_MAP, clasificadores de etiquetas
  state.js                  ← objeto state, switchView(), búsqueda, filtros
  home.js                   ← buildHomeDBGrid(), buildHomeRecent(), initCounts()
  explore.js                ← renderTable(), rowHTML(), chips, filterByTag(), filterBySeries()
  charts.js                 ← buildDonut(), buildDist()
  detail.js                 ← openDetailByIdx(), closeDetail(), panel lateral
  intelligence.js           ← motor analítico: frecuencias, oportunidades, candidatos
  investigations.js         ← máquina de estados, transiciones, formulario de propuestas
  integrity.js              ← runIntegrityAudit(), renderIntegrity()
  boot.js                   ← bootKnowledgeHub(): fetch JSON, init, primer render
```

Cada módulo usa `<script type="module">` con `import`/`export`. Sin bundler, sin npm, sin CDN.

### 1.4 Orden de migración

Cada paso produce un commit funcional. Si algo se rompe, se revierte un solo módulo.

1. Crear `js/sanitize.js` — no depende de nada; se puede escribir y testear contra los datos actuales.
2. Extraer `css/` — separar los tres bloques de CSS en archivos con `<link>`. Cambio visual cero.
3. Extraer `js/data.js` — constantes puras sin dependencias.
4. Extraer `js/state.js` — el corazón: objeto `state` y `switchView()`.
5. Extraer vistas una por una: explore → intelligence → investigations → integrity → home. En cada extracción, reemplazar `innerHTML` por `textContent` + `sanitize` donde corresponda.
6. Extraer `js/detail.js` y `js/charts.js`.
7. Crear `js/boot.js` como punto de entrada que importa todo.
8. Reducir `index.html` al shell con CSP y `<script type="module" src="js/boot.js">`.
9. Añadir `.gitignore`.

### 1.5 Otros defectos menores

- Sin `.gitignore` en el repositorio.
- IDs de data sources de Notion expuestos en `config/notion-sources.json` (evaluar si el repo será público).
- README.md de 2 líneas sin documentación de la arquitectura.

---

## 2. Integridad — Evolución de la auditoría interna

Objetivo: ampliar el sistema de integridad existente para que no solo audite los datos extraídos de Notion, sino también la coherencia entre el código y la realidad.

### 2.1 Estado actual

El sistema de integridad tiene dos secciones:

- **Sección A — Anomalías automáticas**: `runIntegrityAudit()` detecta IDs duplicados, notionIds duplicados, URLs duplicadas, notionId ≠ hash de URL, entradas sin ID, entradas sin URL, campos estructurales inválidos, relaciones no resueltas.
- **Sección B — Anomalías documentadas**: entries en DATA con campo `_dataIntegrityIssue` que representan conocimiento humano que la máquina no puede deducir.

### 2.2 Sección C — Coherencia código-datos (**Implementado** — commit `edd6da2`)

Detecta divergencias entre lo que el código asume y lo que los datos reales contienen.

**C-1. Valores HTML estáticos vs. DATA**

Al cargar la página, capturar el contenido original de los elementos contadores (`nc-total`, `h-total`, etc.) antes de que `initCounts()` los actualice. Después del fetch, comparar el valor estático con el calculado. Si difieren, reportar la divergencia con ambos valores.

```
Detección: "El sidebar mostraba 236 entradas durante 0.8s antes de actualizarse a 331"
Causa: "El HTML contiene un valor fijo que no se actualiza con cada sincronización"
```

**C-2. SYSTEM_STATE vs. DATA**

Comparar cada campo de `SYSTEM_STATE` con la realidad:

- `SYSTEM_STATE.total` vs. `DATA.length`
- `SYSTEM_STATE.dbs[id].count` vs. `DATA.filter(d => d.db === name).length` para cada DB
- `SYSTEM_STATE.last_sync` vs. timestamp del JSON cargado
- `SYSTEM_STATE.version` vs. versión del esquema real

**C-3. Metadatos vs. DATA**

- Bases en `DB_META` que no tienen entradas en DATA (DB definida pero vacía o eliminada de Notion).
- Bases en DATA que no aparecen en `DB_META` (nueva base sincronizada sin configurar).
- Bases en `AREA_MAP` que no están en `DB_META` (incoherencia de configuración).

**C-4. Constantes hardcodeadas**

Detectar valores numéricos literales en el código que coinciden con conteos antiguos pero no con los actuales. El `325` de `resolvedCount` en L4069 es el ejemplo concreto: debería calcularse dinámicamente.

**C-5. Esquema de datos**

Detectar campos que el código espera pero los datos no traen, y campos que los datos traen pero el código ignora. Ejemplo: si `sync-notion.mjs` empieza a exportar un campo nuevo, la integridad debería reportar "campo `X` presente en 45 entradas pero no usado en ninguna vista".

### 2.3 Regla arquitectónica (extendida)

La regla existente dice:

> Detectar automáticamente. Explicar automáticamente. Corregir automáticamente solo cuando la identidad sea inequívoca.

Para la sección C se añade:

> El código no debe contener valores que los datos puedan contradecir. Toda constante derivable de DATA debe calcularse en tiempo de ejecución.

---

## 3. Research Engine → Intelligence

Objetivo: research-engine es el backend que eventualmente alimentará y reemplazará el motor local de Intelligence y la máquina de estados de Investigations.

### 3.1 Qué resuelve research-engine que Knowledge Hub no puede

| Capacidad | Knowledge Hub (actual) | Research Engine (futuro) |
|-----------|----------------------|-------------------------|
| Investigaciones | Máquina de estados local en memoria; los cambios se pierden al recargar | Persistencia en PostgreSQL, eventos, concurrencia optimista |
| Propuestas | Formulario que crea un objeto JS temporal | API REST con validación, ciclo de vida completo, visibilidad (PUBLIC/UNLISTED/PRIVATE) |
| Participación | No existe | Supports anónimos con HMAC-SHA-256, rate limiting multi-scope |
| Evidencia | No existe | Modelo Source → Claim → Evidence con stances |
| Scores | No existe | Dimensiones PRIORITY/PROGRESS/CONFIDENCE/SUPPORT_COUNT con políticas versionadas |
| Integridad | Auditoría de datos Notion | + Auditoría de coherencia código-datos (sección 2) |

### 3.2 Cómo convergen

La máquina de estados de Investigations en Knowledge Hub ya usa los mismos estados que research-engine:

```
proposal → draft → active → paused → concluded → archived
                                   → abandoned
```

Esto no es casualidad — están diseñados para ser el mismo sistema. La diferencia es que hoy `transitionInv()` muta un array local, y con research-engine será un `POST /proposals/:id/open` real.

### 3.3 Preparación en la modularización

Durante la modularización (sección 1), la capa de datos se prepara para dos fuentes:

```
js/
  data/
    sources.js            ← registro de fuentes (Notion JSON hoy, API mañana)
    content-store.js      ← carga, indexa y expone entradas de contenido
    research-store.js     ← investigaciones y propuestas
```

- `content-store.js` abstrae `fetch('./data/content.json')`. Cuando research-engine tenga endpoint de contenido, se cambia la implementación sin tocar vistas.
- `research-store.js` abstrae `fetch('./data/investigations.json')`. Cuando research-engine esté en producción, pasa a consumir la API REST. Las funciones `transitionInv()`, `saveProposalAsInvestigation()` dejan de mutar estado local y pasan a hacer llamadas HTTP.
- Las vistas no saben de dónde vienen los datos.

### 3.4 Qué NO cambia en Knowledge Hub cuando research-engine se integre

- El sistema de integridad sigue siendo del frontend — audita lo que el usuario ve, no lo que el backend almacena.
- Los CSS, el layout, el sidebar, la navegación por vistas — no dependen del backend.
- El motor de Intelligence (frecuencias, oportunidades, candidatos) sigue calculando sobre DATA local; research-engine añade capacidades (propuestas, evidencia, scores) pero no reemplaza el análisis de señales.

### 3.5 Qué SÍ cambia

- Intelligence ganará acceso a claims, evidencia y scores reales en lugar de solo etiquetas y frecuencias.
- Investigations dejará de ser efímero — cada transición será una operación persistente con eventos.
- Se podrá añadir participación (supports) directamente desde la interfaz.
- La integridad (sección C) podrá comparar estado local vs. estado del backend y detectar divergencias de sincronización.
