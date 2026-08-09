# Plan — Ingesta Gmail → Knowledge Hub y enriquecimiento de las BDD de Notion

Ámbito: `Schoolonchain/knowledg_hub` (sitio y sincronización) y las diez fuentes de
Notion declaradas en `config/notion-sources.json`.

Instantánea analizada: `data/content.json`, `generatedAt` **2026-07-25T23:24:54Z**,
**331 entradas** en 9 bases de contenido (+ investigaciones aparte).

---

## 0. Estado de ejecución

Este documento es el **plan**. Dos de los tres pasos que lo componen no se han podido
ejecutar en esta sesión por falta de acceso a herramientas, no por decisión de diseño:

| Paso | Estado | Motivo |
|------|--------|--------|
| A. Revisión de Gmail y triaje de candidatos | **No ejecutado** | El conector Gmail está autenticado a nivel de organización pero desactivado en este chat (`enabledInChat: false`); sus herramientas no están cargadas. |
| B. Escritura en las BDD de Notion | **No ejecutado** | El conector Notion sólo expone `notion-convert-page-to-skill`. No hay herramientas de búsqueda, lectura ni actualización de páginas. |
| C. Diagnóstico de huecos y backlog | **Ejecutado** | Calculado sobre `data/content.json` del repositorio del Hub. |

Para desbloquear A y B: activar **Gmail** en los ajustes de conectores de este chat y
habilitar el conjunto completo de herramientas del conector **Notion** (lectura y
escritura de páginas). Con ambos activos, las secciones 1 y 3 son ejecutables tal como
están escritas.

---

## 1. Paso A — De Gmail al Hub

### 1.1 Mapeo remitente → base de destino

Las bases del Hub reflejan fuentes que llegan por correo. El triaje asigna cada mensaje
a una base concreta:

| Origen del mensaje | Base de destino | `key` |
|---|---|---|
| Boletín TLDR (dev/IA/infosec) | 💻 TLDR Dev | `tldr` |
| El Rincón del Hacker | 🔐 El Rincón del Hacker | `hacker-corner` |
| OSINT Newsletter | 🔎 OSINT Newsletter | `osint` |
| PWN / Hacker Community | 🔓 PWN \| Hacker Community | `pwn` |
| Libros, cursos, papers, recursos de referencia | 📚 Biblioteca | `library` |
| Publicaciones propias (Medium y equivalentes) | ✍️ Artículos propios | `articles` |
| Entrevistas y transcripciones | 🎙️ Entrevistas | `interviews` |

Un mensaje que no encaje en ninguna base **no se fuerza**: se descarta o se anota como
candidato a investigación (`🔬 Investigaciones`).

### 1.2 Criterios de admisión

Se añade al Hub lo que cumpla las tres condiciones:

1. **Contenido sustantivo**, no promocional ni administrativo.
2. **Enlace estable y público** — sin él no hay `urlFuente` y la entrada nace incompleta.
3. **No duplicado** — comprobar contra `data/content.json` por URL normalizada y por
   título. La auditoría de integridad del Hub ya detecta URLs y `notionId` duplicados;
   el objetivo es no crearlos.

### 1.3 Campos mínimos al crear una entrada

Ninguna entrada debe nacer con los huecos que la sección 2 documenta. Mínimo obligatorio:
`Título`, `URL fuente`, `Fecha publicación`, `Descripción`, `Etiquetas` (≥2, del
vocabulario controlado — ver 3.3).

---

## 2. Paso B — Mapeo real de propiedades de Notion

Extraído de `scripts/sync-notion.mjs`. El sincronizador resuelve cada campo del Hub
tomando **la primera propiedad no vacía** de una lista de alias, por lo que los nombres
de propiedad varían entre bases y todos los de una fila son equivalentes:

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

Traducción de los tres conceptos del encargo:

- **Etiqueta** → `Etiquetas` (multi_select).
- **Contenidos relacionados** → `Entradas relacionadas` (relation).
- **Contenidos complementarios** → se reparten en tres relaciones distintas según su
  naturaleza: `Glosario`/`Conceptos` (terminológico), `Entrevistas de origen`
  (procedencia) y `Anterior`/`Siguiente` (secuencia dentro de una serie).

Notas de comportamiento que condicionan el trabajo:

- Las `relation` se serializan como **ID de página sin guiones**. Una relación apuntando
  a una página no incluida en la sincronización queda como referencia no resuelta y la
  auditoría del Hub la marca.
- En `🔬 Investigaciones` sólo se exporta lo que tenga `Publicar = true`.
- `Etiquetas` cae a `Nivel` como último alias: en las bases sin `Etiquetas` propias, el
  nivel de dificultad acaba ocupando el campo de etiquetas. Eso explica que `Avanzado`,
  `Intermedio`, `Fundamental` y `Básico` aparezcan entre las etiquetas más frecuentes.

---

## 3. Paso C — Diagnóstico y backlog de enriquecimiento

### 3.1 Huecos por base (331 entradas)

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

Lectura: las columnas `sin Fecha` y `sin URL fuente` de las dos bases de glosario no son
defectos — un término no tiene fecha de publicación ni enlace de origen. El resto sí.

### 3.2 Backlog priorizado

**P1 — 📚 Biblioteca (49 entradas, la base más incompleta).**
49/49 sin descripción, sin URL fuente y sin relacionadas. Es la única base donde la
carencia es total: hoy son títulos sin contexto. Añadir `Descripción` y `URL fuente` es
lo que la convierte en usable; las relaciones vienen después.

**P2 — 💻 TLDR Dev (94 entradas).**
94/94 sin fecha, pese a proceder de un boletín diario donde la fecha existe siempre y es
recuperable del propio correo. Además 46 sin relacionadas y 17 sin etiquetas ni
descripción. Es la base con mayor volumen y la que más se beneficia del cruce con
`📖 Glosario TLDR` (38 conceptos ya definidos, 0 entradas de TLDR Dev los referencian).

**P3 — ✍️ Artículos propios (65 entradas).**
60/65 sin descripción y 65/65 sin relacionadas ni glosario. Al ser contenido propio, es
donde las relaciones aportan más: son los artículos que deberían enlazar entre sí y con
las entrevistas de origen (`🎙️ Entrevistas` ya tiene sus 8 relaciones completas, pero
en un solo sentido).

**P4 — 🔐 El Rincón del Hacker (35 entradas).** 35 sin fecha, 28 sin relacionadas.

**P5 — Cruce glosarios ↔ contenido.**
Las dos bases de glosario suman 78 términos y **ninguna entrada de contenido los
referencia** (`sin Glosario` = 100 % en todas las bases salvo OSINT y Rincón parcial).
Este es el enlace de mayor rendimiento: convierte 78 definiciones aisladas en la capa de
navegación conceptual del Hub.

### 3.3 Higiene del vocabulario de etiquetas

Estado actual: **88 etiquetas distintas en uso**, frente a **36 títulos únicos** en
`🏷️ Glosario de Etiquetas` (40 entradas, ver duplicados abajo). **67 etiquetas en uso no
tienen entrada en el glosario**, incluidas las más frecuentes:

`IA` (59), `Avanzado` (39), `Intermedio` (37), `Fundamental` (36), `Agentes IA` (30),
`Análisis on-chain` (22), `Backend` (16), `Modelos LLM` (16), `Seguridad` (14),
`Básico` (14), `Blockchain` (11), `TRON` (10), `RCE` (10).

Acciones:

1. **Separar nivel de tema.** `Avanzado`/`Intermedio`/`Fundamental`/`Básico` son nivel de
   dificultad, no materia, y sólo aparecen como etiquetas por el alias `Nivel` del
   sincronizador. Darles propiedad propia y sacarlos del recuento de etiquetas.
2. **Dar entrada de glosario a las etiquetas troncales** — al menos `IA`, `Agentes IA`,
   `Modelos LLM`, `Análisis on-chain`, `Blockchain`, `Backend`, `Seguridad`.
3. **Resolver los 4 duplicados del glosario**, que apuntan al mismo concepto con dos IDs:

   | Etiqueta | IDs duplicados |
   |---|---|
   | Blue Team | `GLC-5` / `GLC-37` |
   | Control de acceso | `GLC-3` / `GLC-39` |
   | Red Team | `GLC-4` / `GLC-36` |
   | Reconocimiento | `GLC-9` / `GLC-38` |

   Conservar el ID bajo (serie `GLC-3..9`, la original), migrar las relaciones del alto y
   archivar el duplicado. Hacerlo **antes** de crear relaciones nuevas hacia el glosario,
   o se repartirán entre las dos copias.
4. **Consolidar granularidad de cadenas.** `TRON`, `Solana`, `Ethereum`, `TON`, `SUI`,
   `Avalanche`, `Base`, `BTC`, `Bitcoin`, `Litecoin`, `Namecoin`, `Grin` conviven como
   etiquetas planas; `BTC` y `Bitcoin` son además el mismo concepto. Unificar y decidir si
   la cadena concreta es etiqueta o propiedad `Ecosistema`.

---

## 4. Orden de ejecución recomendado

1. Higiene de vocabulario (3.3.1 y 3.3.3) — **primero**, porque condiciona todo enlace
   posterior hacia el glosario.
2. P1 Biblioteca: descripción + URL fuente.
3. P2 TLDR Dev: fechas desde los correos de origen (requiere Gmail).
4. P5 Cruce glosarios ↔ contenido.
5. P3/P4 Relaciones entre artículos, entrevistas y Rincón del Hacker.
6. Paso A: ingesta de los mensajes nuevos de Gmail, ya con el vocabulario saneado.

Tras cada tanda, ejecutar el workflow de sincronización y revisar la vista de integridad
del Hub: las relaciones no resueltas y los duplicados aparecen ahí sin trabajo adicional.

---

## 5. Riesgo conocido

`SYSTEM_STATE.total` y `SYSTEM_STATE.dbs[*].count` siguen codificados a mano en
`js/data.js` del Hub (documentado en `KNOWLEDGE_HUB_MIGRATION.md` §1.2 y §1.6). Al añadir
entradas, esos contadores divergirán y el check C-2 los marcará. La corrección definitiva
es autogenerar `SYSTEM_STATE` en `sync-notion.mjs`; hasta entonces, la divergencia tras
una ingesta es esperada y no un fallo nuevo.
