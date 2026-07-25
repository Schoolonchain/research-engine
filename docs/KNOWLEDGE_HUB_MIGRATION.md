# Knowledge Hub — Plan de evolución

Tres líneas de trabajo independientes. Cada una puede avanzar sin esperar a las demás.

---

## 1. Knowledge Hub — Correcciones y modularización

Objetivo: corregir los defectos de seguridad detectados en la auditoría y dividir el monolito `index.html` (541 KB, 4 274 líneas) en archivos separados.

### 1.1 Defectos de seguridad (bloqueantes) — **Completado**

| # | Defecto | Estado | Commit |
|---|---------|--------|--------|
| S-1 | 47 `innerHTML` con datos de Notion sin sanitizar (XSS almacenado) | **Resuelto** | `f30fe69` + `2766755` + `ec648fc` |
| S-2 | Sin Content-Security-Policy | **Resuelto** | `504be37` |
| S-3 | 51 `onclick` inline — migrados a `addEventListener` delegation | **Resuelto** | `beada7e` |
| S-4 | Workflow push directo a main — ahora usa `create-pull-request` | **Resuelto** | `9803335` |
| S-5 | Auto-descarga `outerHTML` — ahora fetch del archivo original | **Resuelto** | `9803335` |

### 1.2 Valores estáticos desacoplados — **Resuelto** (`b2ece8f`)

Todos los contadores HTML nacen con placeholder `—` y se calculan desde DATA en `initCounts()`:

| Elemento | Antes | Ahora | Fuente |
|----------|-------|-------|--------|
| `#nc-total`, `#h-total`, `#exp-total` | 236 / 244 | `—` → `DATA.length` | `initCounts()` |
| `#nc-ciber` / `#nc-tech` / `#nc-cripto` | 47 / 83 / 106 | `—` → conteo por área | `initCounts()` |
| `#a-ciber` / `#a-tech` / `#a-cripto` | "47 entradas" etc. | `—` → dinámico | `initCounts()` |
| `#a-ciber-dbs` / `#a-tech-dbs` / `#a-cripto-dbs` | "4 / 2 / 2" (cripto era incorrecto: tiene 3) | `—` → `AREA_MAP[area].length` | `initCounts()` |
| `#h-dbs`, `#exp-dbs` | 9 (hardcoded) | `—` → `DB_LIST.length` | `initCounts()` |
| `#h-art`, `#h-glos`, `#exp-art`, `#exp-glos` | 65 / 67 | `—` → filtros sobre DATA | `initCounts()` |
| `#nc-inv` | 1 | `—` → investigaciones activas | `initCounts()` |
| `#nc-integrity` | ✅ (prebaked) | `—` → audit badge | `initCounts()` |
| `#result-count`, `#table-foot-count` | "236 de 236" | `—` → dinámico | `renderTable()` |
| `#table-foot-date` | "Actualizado 21 jul 2026" | `—` → `SYSTEM_STATE.last_sync` | `initCounts()` |
| `resolvedCount` | 325 (hardcodeado en JS) | Calculado: `totalRefs - totalUnresolved` | `renderIntegrity()` |

**Pendiente**: `SYSTEM_STATE.total` y `SYSTEM_STATE.dbs[*].count` siguen hardcodeados en `data.js`. La auditoría de integridad (C-2) los detecta correctamente como divergentes. La solución definitiva es auto-generar `SYSTEM_STATE` en `sync-notion.mjs`.

C-1 de integridad actualizado para ignorar placeholders `—` (no son valores obsoletos).

### 1.3 Modularización — **Completado** (commits `93361d7` a `cc58c6c`)

### 1.4 ES Modules — **Completado** (`5bffea9`)

Todos los archivos JS convertidos a ES modules con `import`/`export`:

```
index.html                  ← shell HTML + <script type="module" src="js/boot.js">
css/
  tokens.css                ← custom properties (colores, radii, tipografía)
  layout.css                ← sidebar, main, topbar, responsive
  components.css            ← cards, pills, badges, tablas, formularios
  views.css                 ← estilos de intelligence, investigations, integrity
js/
  sanitize.js               ← escapeHTML(), safeURL(), truncEsc() — leaf module
  data.js                   ← DB_META, AREA_META, AREA_MAP, SYSTEM_STATE, DATA, setDATA() — leaf module
  state.js                  ← state, switchView(), registerRenderer(), recomputeDerivedData()
  home.js                   ← buildHomeDBGrid(), buildHomeRecent()
  explore.js                ← renderTable(), buildChips(), goExploreArea(), goExploreDB(), filterByTag()
  charts.js                 ← buildDonut(), buildDist()
  detail.js                 ← openDetailByIdx(), closeDetail(), delegación en tbody
  intelligence.js           ← renderIntelligence(), computeTagFrequencies(), TAG_CLASSIFIER
  investigations.js         ← renderInvestigations(), transitionInv(), suggestInvestigation(), toggleOppEntries()
  integrity.js              ← runIntegrityAudit(), renderIntegrity(), captura _staticCounters
  boot.js                   ← entry point: imports, registerRenderer, delegación global, initCounts(), bootKnowledgeHub()
```

Grafo de dependencias (DAG, sin ciclos):

```
data.js ◄─── state.js ◄─── explore.js ◄─── home.js
  │              │              │              │
  │              │              ├──── charts.js
  │              │              │
  │              ├──── detail.js
  │              │
sanitize.js ◄───┤
  │              │
  ├──── intelligence.js ◄─── investigations.js
  │
  ├──── integrity.js
  │
  └──── boot.js (entry point — importa todo, nadie lo importa)
```

Resolución de dependencias circulares:
- **Renderer registry**: `registerRenderer(view, fn)` en state.js; boot.js registra los renderers
- **goExploreArea/goExploreDB**: movidos de state.js a explore.js
- **initCounts**: movido a boot.js (necesita runIntegrityAudit de integrity.js)
- **_staticCounters**: capturado en integrity.js a nivel de módulo (deferred execution)
- **setDATA/setINVESTIGATIONS**: funciones setter en data.js (imports son read-only en ES modules)

CSP actualizado: `script-src 'self'` (sin `'unsafe-inline'`).

index.html: 587 líneas (shell HTML puro, cero JavaScript inline).

### 1.5 Orden de migración completo

| Paso | Descripción | Commit | Estado |
|------|-------------|--------|--------|
| 1 | `js/sanitize.js` — módulo + 32 tests | `f30fe69` | **Hecho** |
| 2 | CSS → `tokens.css`, `layout.css`, `components.css`, `views.css` | `93361d7` | **Hecho** |
| 3 | `js/data.js` — DB_META, AREA_META, AREA_MAP, SYSTEM_STATE, DATA | `db2a74e` | **Hecho** |
| 4 | `js/state.js` — state, switchView, navegación | `c6f048b` | **Hecho** |
| 5-8 | Vistas + detail + charts + boot (8 archivos) | `cc58c6c` | **Hecho** |
| 9 | `.gitignore` | `eb767e5` | **Hecho** |
| 10 | ES Modules: import/export + CSP sin unsafe-inline | `5bffea9` | **Hecho** |
| 11 | Valores estáticos → placeholders dinámicos | `b2ece8f` | **Hecho** |

### 1.6 Defectos menores pendientes

- ~~Sin `.gitignore` en el repositorio.~~ **Resuelto** (`eb767e5`)
- `SYSTEM_STATE` hardcodeado en `data.js` — auto-generar en `sync-notion.mjs` o eliminar.
- IDs de data sources de Notion expuestos en `config/notion-sources.json` (evaluar si el repo será público).
- README.md de 2 líneas sin documentación de la arquitectura.

---

## 2. Integridad — Evolución de la auditoría interna — **Completado**

Objetivo: ampliar el sistema de integridad existente para que no solo audite los datos extraídos de Notion, sino también la coherencia entre el código y la realidad.

### 2.1 Estado actual

El sistema de integridad tiene tres secciones:

- **Sección A — Anomalías automáticas**: `runIntegrityAudit()` detecta IDs duplicados, notionIds duplicados, URLs duplicadas, notionId ≠ hash de URL, entradas sin ID, entradas sin URL, campos estructurales inválidos, relaciones no resueltas.
- **Sección B — Anomalías documentadas**: entries en DATA con campo `_dataIntegrityIssue` que representan conocimiento humano que la máquina no puede deducir.
- **Sección C — Coherencia código-datos** (`edd6da2`): detecta divergencias entre el código y DATA.

### 2.2 Sección C — Coherencia código-datos (**Implementado** — commit `edd6da2`)

| Check | Descripción | Estado |
|-------|-------------|--------|
| C-1 | Valores HTML estáticos vs. DATA | **Implementado** — ignora placeholders `—` tras fix 1.2 |
| C-2 | SYSTEM_STATE.total / dbs vs. DATA | **Implementado** |
| C-3 | DB_META / AREA_MAP vs. DATA | **Implementado** |
| C-4 | Constantes hardcodeadas sospechosas | **Implementado** |
| C-5 | Campos en DATA no usados por vistas | **Implementado** |

### 2.3 Regla arquitectónica (extendida)

> Detectar automáticamente. Explicar automáticamente. Corregir automáticamente solo cuando la identidad sea inequívoca.
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
| Integridad | Auditoría de datos Notion + coherencia código-datos | + comparación estado local vs. backend |

### 3.2 Cómo convergen

La máquina de estados de Investigations en Knowledge Hub ya usa los mismos estados que research-engine:

```
proposal → draft → active → paused → concluded → archived
                                   → abandoned
```

Esto no es casualidad — están diseñados para ser el mismo sistema. La diferencia es que hoy `transitionInv()` muta un array local, y con research-engine será un `POST /proposals/:id/open` real.

### 3.3 Preparación en la modularización

Con ES modules implementados, la capa de datos está lista para abstracción a dos fuentes:

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
