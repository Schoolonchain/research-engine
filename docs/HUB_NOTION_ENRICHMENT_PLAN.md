# Plan — Ingesta Gmail → Knowledge Hub y enriquecimiento de las BDD de Notion

Ámbito: `Schoolonchain/knowledg_hub` (sitio y sincronización) y las diez fuentes de
Notion declaradas en `config/notion-sources.json`.

Instantánea analizada: `data/content.json`, `generatedAt` **2026-07-25T23:24:54Z**,
**331 entradas**. Revisión de Gmail: **2026-07-25 → 2026-08-09**.

---

## 0. Bloqueo previo — la sincronización del Hub está caída

**Esto va antes que cualquier ingesta.** El workflow `Sync Notion and audit` de
`knowledg_hub` está fallando de forma continuada sobre `main` (169e80a). En la bandeja hay
al menos **5 ejecuciones fallidas consecutivas el 2026-08-09** entre las 05:32 y las 09:21
UTC, cada una con 2 anotaciones de error y una duración de ~19 s. El cron es
`7,22,37,52 * * * *`, es decir, se reintenta cada 15 minutos y falla siempre.

Consecuencia directa: `data/content.json` sigue congelado en el **25 de julio**. Aunque se
carguen entradas nuevas en Notion, **no llegarán al Hub** hasta que el workflow vuelva a
pasar.

No he podido leer los logs del run desde esta sesión: `knowledg_hub` no está adjunto y la
API de GitHub sólo tiene alcance sobre `research-engine`. Las dos causas más probables,
por orden, **sin confirmar**:

1. **Una o varias fuentes de Notion perdieron el permiso de la integración.**
   `sync-notion.mjs` acumula los fallos por fuente y termina lanzando
   `La integración no puede leer N fuente(s)…`. Es el único punto del script que produce un
   error tras haber hecho llamadas reales, lo que encaja con los ~19 s de duración.
2. **`NOTION_API_KEY` caducada o revocada**, que produciría el mismo desenlace en todas las
   fuentes a la vez.

Para confirmarlo basta con abrir el run
(`https://github.com/Schoolonchain/knowledg_hub/actions/runs/31296901355`): el propio script
imprime `<nombre de la fuente>: ERROR — <mensaje>` por cada base que no puede leer. Si
quieres, adjunto el repo a la sesión y lo diagnostico.

---

## 1. Paso A — Candidatos reales encontrados en Gmail

**131 mensajes** de las cuatro fuentes ya declaradas, posteriores a la última
sincronización. Ninguno está en `content.json`.

| Fuente | Base de destino | Mensajes | Rango |
|---|---|--:|---|
| `dan@tldrnewsletter.com` | 💻 TLDR Dev | **108** | 27 jul – 7 ago |
| `pwnhackers@substack.com` | 🔓 PWN \| Hacker Community | **16** | 27 jul – 9 ago |
| `mario@elrincondelhacker.es` | 🔐 El Rincón del Hacker | **4** | 4 – 9 ago |
| `osintnewsletter@substack.com` | 🔎 OSINT Newsletter | **3** | 30 jul – 6 ago |

El desequilibrio es real y conviene tenerlo presente: TLDR aporta el 82 % del volumen
porque son ~10 boletines temáticos distintos al día (IA, InfoSec, Web Dev, Crypto,
Marketing, Design, Founders…) que llegan todos desde el mismo remitente. Las otras tres
fuentes son de una pieza por envío.

### 1.1 🔐 El Rincón del Hacker — 4 entradas, todas admitidas

Contenido formativo en español, encaja con las 35 entradas existentes (`RDH-1`…`RDH-35`).
Continuaría la numeración desde `RDH-36`.

| Fecha | Título | Etiquetas propuestas |
|---|---|---|
| 09 ago | Cómo construir un portfolio de hacking ético que consiga entrevistas | `Metodología`, `Bug Bounty`, `Fundamental` |
| 07 ago | Lo que nadie te explica sobre el informe de pentest | `Metodología`, `Red Team`, `Intermedio` |
| 06 ago | Active Directory: por qué el 80 % de los ataques corporativos pasan por aquí | `Active Directory`\*, `Control de acceso`, `Red Team`, `Intermedio` |
| 04 ago | El ataque de Supply Chain que comprometió 18.000 empresas (SolarWinds explicado) | `Supply chain`\*, `Blue Team`, `Intermedio` |

\* Etiqueta nueva — requiere alta previa en 🏷️ Glosario de Etiquetas (ver §3.3).

### 1.2 🔓 PWN — 12 admitidas, 4 descartadas

La base sólo tiene 1 entrada (`PWN-1`), así que esto la multiplica por trece.

Admitidas: fibra intervenida en Black Hat 2026 (9 ago) · investigador infiltrado 22 meses
en operaciones norcoreanas (7 ago) · BIOS de HP desbloqueada con Claude Code (4 ago) ·
Wi-Fi de hoteles secuestrado con falsas actualizaciones (2 ago) · IA supera al humano en
estafas románticas (1 ago) · Apple demandada por estafa cripto de 1,8 M$ (31 jul) ·
«AI Researchers Claim Security is Impossible» (30 jul) · chats de Claude indexados en
Google (30 jul) · Anthropic rompe HAWK-256 post-cuántico y acelera AES-128 (29 jul) ·
GrapheneOS y el borrado en un registro aeroportuario (28 jul) · guía «So You Want to Be an
Ethical Hacker» (27 jul, → 📚 Biblioteca, no PWN) · AMA con Yuhang Wu sobre IA y
vulnerabilidades críticas (31 jul, → 🎙️ Entrevistas).

Descartadas por ser **anuncios promocionales sin contenido propio** — encajan en el
criterio de admisión §2.2: los dos «Don't miss the AMA…» (5 y 6 ago), el «Upcoming AMA:
Yuhang Wu» (30 jul) y el «Ask Him Anything» (28 jul). Las AMA sí entran, pero por su
recapitulación, no por su convocatoria.

Nota: dos de estas entradas se solapan con el Rincón del Hacker, que ya cubrió temas
equivalentes (`RDH-35` sobre la FCC y burner phones coincide con `PWN-1`). Al crearlas,
enlazarlas entre sí en `Entradas relacionadas` en lugar de dejarlas como duplicados
temáticos.

### 1.3 🔎 OSINT — 3 admitidas

Issue #117 «Everything Must Go (Including Their OPSEC): OSINT on eCommerce and
Marketplace» (6 ago) · Episode 22 «Reply Guys and Robot Toolsmiths» (31 jul, podcast) ·
Issue #116 «Create an OSINT Tool that Constantly Improves» (30 jul).

Los tres enlazan con `OSN-1` (Leaker, agregador de brechas) y con las etiquetas
`OSINT pasivo`, `Reconocimiento`, `Breach database` ya definidas en el glosario.

### 1.4 💻 TLDR Dev — 108 mensajes

Es la única fuente donde recomiendo **no cargar uno a uno**. Las entradas existentes
(`TDV-1`…`TDV-94`) están agrupadas por boletín y día (`TDV-67 · Google Photos AI Search,
Webflow MCP e iPhone Ultra`), es decir, ya se venía consolidando un correo → una entrada.
Manteniendo ese criterio, 108 correos ≈ 108 entradas nuevas, continuando desde `TDV-95`.

Temas dominantes del periodo, útiles para etiquetar en bloque: gusano npm Shai-Hulud
(1.280+ paquetes comprometidos, 4 y 6 ago), reorganización de Google DeepMind, adquisición
de Taalas por AMD, GPT-5.6 Luna, agentic harnesses y Agent Skills, Arc Mainnet de Circle,
DynamoDB con búsqueda vectorial, y el bug de root en `screensharingd` de macOS.

---

## 2. Fuentes nuevas detectadas — decisión pendiente

Cuatro remitentes recurrentes en la bandeja **no tienen base en el Hub**. No he asumido
nada sobre ellos; requieren tu criterio antes de crear nada:

| Remitente | Materia | Encaje |
|---|---|---|
| `newsletter@codigoyi.com` | IA aplicada y hacking, en español | Alto — mismo público que el Rincón del Hacker |
| `artemisxyz@substack.com` | Tesis de inversión, cripto, mercado | Medio — cruza con `Análisis on-chain`, `DeFi`, `Mercado` |
| `ryanmcbeth@substack.com` | Geopolítica y defensa | Bajo — fuera del eje actual del Hub |
| `on+stories@substack.com` | Periodismo de investigación | Bajo |

Opciones: base propia nueva, absorberlos en una base existente, o ignorarlos.

---

## 3. Criterios, mapeo y estado de las BDD

### 3.1 Criterios de admisión

1. **Contenido sustantivo**, no promocional ni administrativo.
2. **Enlace estable y público** — sin él no hay `urlFuente` y la entrada nace incompleta.
3. **No duplicado** — comprobar contra `data/content.json` por URL normalizada y título.

Campos mínimos al crear: `Título`, `URL fuente`, `Fecha publicación`, `Descripción`,
`Etiquetas` (≥2, del vocabulario controlado).

### 3.2 Mapeo real de propiedades de Notion

Extraído de `scripts/sync-notion.mjs`. El sincronizador toma **la primera propiedad no
vacía** de una lista de alias, así que todos los nombres de una fila son equivalentes:

| Campo del Hub | Propiedades de Notion aceptadas (en orden) |
|---|---|
| `title` | `Título`, `Titulo`, `Nombre`, `Name`, `Etiqueta`, `Concepto`, `Entrevista completa` |
| `etiquetas` | `Etiquetas`, `Ecosistema`, `Tags`, `Temas`, `Nivel` |
| `relacionadas` | `Entradas relacionadas`, `Relacionadas`, `Artículos derivados` |
| `glosario` | `Glosario`, `Conceptos` |
| `entrevistas` | `Entrevistas de origen`, `Entrevista origen`, `Entrevistas` |
| `anterior` / `siguiente` | `Anterior` / `Siguiente` |
| `desc` | `Descripción`, `Descripcion`, `Resumen`, `Notas`, `Contenido derivado` |
| `fecha` | `Fecha publicación`, `Fecha de publicación`, `Fecha`, `Última revisión`, `Actualizada` |
| `urlFuente` | `URL Medium`, `URL fuente`, `URL original`, `Fuente`, `Enlace` |
| `tipo` | `Tipo`, `Categoría`, `Categoria`, `Estado` |
| `serie` | `Serie`, `Sección`, `Seccion`, `Módulo`, `Modulo` |
| `lectura` | `Lectura (min)`, `Lectura`, `Duración`, `Duracion` |

Los tres conceptos del encargo:

- **Etiqueta** → `Etiquetas` (multi_select).
- **Contenidos relacionados** → `Entradas relacionadas` (relation).
- **Contenidos complementarios** → tres relaciones distintas según naturaleza:
  `Glosario`/`Conceptos` (terminológico), `Entrevistas de origen` (procedencia) y
  `Anterior`/`Siguiente` (secuencia dentro de una serie).

Comportamientos que condicionan el trabajo:

- Las `relation` se serializan como **ID de página sin guiones**. Una relación que apunte a
  una página fuera de la sincronización queda como referencia no resuelta.
- En 🔬 Investigaciones sólo se exporta lo que tenga `Publicar = true`.
- `Etiquetas` cae a `Nivel` como último alias: en las bases sin `Etiquetas` propias, el
  nivel de dificultad ocupa el campo de etiquetas. De ahí que `Avanzado`, `Intermedio`,
  `Fundamental` y `Básico` figuren entre las etiquetas más frecuentes.

### 3.3 Huecos por base (331 entradas)

| Base | n | sin Etiquetas | sin Relacionadas | sin Glosario | sin Descripción | sin Fecha | sin URL fuente |
|---|--:|--:|--:|--:|--:|--:|--:|
| ✍️ Artículos propios | 65 | 4 | 65 | 65 | 60 | 23 | 0 |
| 🎙️ Entrevistas | 8 | 0 | 0 | 8 | 0 | 0 | 8 |
| 💻 TLDR Dev | 94 | 17 | 46 | 94 | 17 | 94 | 0 |
| 🔐 El Rincón del Hacker | 35 | 0 | 28 | 23 | 7 | 35 | 0 |
| 🔎 OSINT Newsletter | 1 | 0 | 1 | 0 | 0 | 1 | 0 |
| 🔓 PWN \| Hacker Community | 1 | 0 | 1 | 1 | 0 | 1 | 0 |
| 📚 Biblioteca | 49 | 1 | 49 | 49 | 49 | 6 | 49 |
| 🏷️ Glosario de Etiquetas | 40 | 0 | 13 | 40 | 0 | 40 | 40 |
| 📖 Glosario TLDR | 38 | 0 | 4 | 38 | 0 | 38 | 38 |

`sin Fecha` y `sin URL fuente` en las dos bases de glosario no son defectos: un término no
tiene fecha de publicación ni enlace de origen. El resto sí.

### 3.4 Backlog priorizado de enriquecimiento

**P1 — 📚 Biblioteca (49).** 49/49 sin descripción, sin URL fuente y sin relacionadas. Hoy
son títulos sin contexto. Añadir `Descripción` y `URL fuente` es lo que la vuelve usable.

**P2 — 💻 TLDR Dev (94).** 94/94 sin fecha, pese a venir de boletines diarios donde la
fecha existe siempre y es recuperable del propio correo. Además 46 sin relacionadas y 17
sin etiquetas ni descripción.

**P3 — ✍️ Artículos propios (65).** 60/65 sin descripción, 65/65 sin relacionadas ni
glosario. Al ser contenido propio, es donde las relaciones aportan más.

**P4 — 🔐 El Rincón del Hacker (35).** 35 sin fecha, 28 sin relacionadas.

**P5 — Cruce glosarios ↔ contenido.** Los dos glosarios suman 78 términos y **ninguna
entrada de contenido los referencia**. Es el enlace de mayor rendimiento: convierte 78
definiciones aisladas en la capa de navegación conceptual del Hub.

### 3.5 Higiene del vocabulario de etiquetas

**88 etiquetas distintas en uso** frente a **36 títulos únicos** en 🏷️ Glosario de
Etiquetas (40 entradas). **67 etiquetas en uso no tienen entrada en el glosario**,
incluidas las más frecuentes: `IA` (59), `Avanzado` (39), `Intermedio` (37),
`Fundamental` (36), `Agentes IA` (30), `Análisis on-chain` (22), `Backend` (16),
`Modelos LLM` (16), `Seguridad` (14), `Básico` (14), `Blockchain` (11), `TRON` (10),
`RCE` (10).

1. **Separar nivel de tema.** `Avanzado`/`Intermedio`/`Fundamental`/`Básico` son nivel de
   dificultad, no materia, y sólo aparecen como etiquetas por el alias `Nivel`. Darles
   propiedad propia y sacarlos del recuento.
2. **Dar entrada de glosario a las etiquetas troncales**: al menos `IA`, `Agentes IA`,
   `Modelos LLM`, `Análisis on-chain`, `Blockchain`, `Backend`, `Seguridad`.
3. **Resolver los 4 duplicados del glosario**, que apuntan al mismo concepto con dos IDs:

   | Etiqueta | IDs duplicados |
   |---|---|
   | Blue Team | `GLC-5` / `GLC-37` |
   | Control de acceso | `GLC-3` / `GLC-39` |
   | Red Team | `GLC-4` / `GLC-36` |
   | Reconocimiento | `GLC-9` / `GLC-38` |

   Conservar el ID bajo (serie original `GLC-3..9`), migrar las relaciones del alto y
   archivar el duplicado. Hacerlo **antes** de crear relaciones nuevas hacia el glosario, o
   se repartirán entre las dos copias.
4. **Consolidar granularidad de cadenas.** `TRON`, `Solana`, `Ethereum`, `TON`, `SUI`,
   `Avalanche`, `Base`, `BTC`, `Bitcoin`, `Litecoin`, `Namecoin`, `Grin` conviven como
   etiquetas planas, y `BTC`/`Bitcoin` son el mismo concepto. Unificar y decidir si la
   cadena concreta es etiqueta o propiedad `Ecosistema`.

### 3.6 Términos nuevos que aporta esta tanda

Conceptos que aparecen en los mensajes admitidos y aún no están en ningún glosario:
`Active Directory`, `Supply chain attack`, `Captive portal`, `Shai-Hulud (gusano npm)`,
`GrapheneOS`, `Criptografía post-cuántica`, `Prompt injection`. Darlos de alta en
🏷️ Glosario de Etiquetas o 📖 Glosario TLDR según correspondan a seguridad ofensiva o a
tecnología general, antes de etiquetar con ellos.

---

## 4. Orden de ejecución

0. **Arreglar el workflow de sincronización** (§0). Sin esto, nada de lo demás llega al Hub.
1. Higiene de vocabulario (§3.5.1 y §3.5.3) y alta de términos nuevos (§3.6) — condiciona
   todo enlace posterior hacia el glosario.
2. P1 Biblioteca: descripción + URL fuente.
3. Ingesta de las 4 fuentes con poco volumen: Rincón (4), OSINT (3), PWN (12).
4. P2 TLDR Dev: fechas de las 94 existentes + ingesta de las 108 nuevas.
5. P5 Cruce glosarios ↔ contenido.
6. P3/P4 Relaciones entre artículos, entrevistas y Rincón del Hacker.
7. Decidir sobre las fuentes nuevas de §2.

Tras cada tanda, ejecutar la sincronización y revisar la vista de integridad del Hub: las
relaciones no resueltas y los duplicados aparecen ahí sin trabajo adicional.

---

## 5. Riesgo conocido

`SYSTEM_STATE.total` y `SYSTEM_STATE.dbs[*].count` siguen codificados a mano en
`js/data.js` del Hub (documentado en `KNOWLEDGE_HUB_MIGRATION.md` §1.2 y §1.6). Al añadir
131 entradas, esos contadores divergirán y el check C-2 los marcará. La corrección
definitiva es autogenerar `SYSTEM_STATE` en `sync-notion.mjs`; hasta entonces, la
divergencia tras una ingesta es esperada y no un fallo nuevo.
