# Research Engine — Arquitectura propuesta

Estado: propuesta de Fase 0, pendiente de aprobación humana  
Fecha: 2026-07-24  
Alcance: planificación; no autoriza implementación

## 1. Diagnóstico

### Repositorio privado de desarrollo

El directorio local `C:\Users\Equipo\Documents\GitHub` es un repositorio Git independiente,
vacío, en la rama `main`, sin commits ni remoto configurado. Se adopta como entorno privado
local de planificación del Research Engine. Todavía no puede considerarse un repositorio
privado remoto: debe crearse o asignarse un remoto privado antes de publicar cambios.

No existen aún lenguaje, framework, build, tests, almacenamiento, variables de entorno,
secretos, puntos de entrada ni despliegue del Research Engine. La selección tecnológica
queda deliberadamente pendiente de aprobación.

### Knowledge Hub público

Repositorio de referencia: `Schoolonchain/knowledg_hub`.

- Visibilidad pública, rama principal `main`, activo y tratado como producción.
- Sitio estático sin framework ni backend público.
- Interfaz, estilos y lógica concentrados en `index.html` (~545 KB).
- Lee `data/content.json` y `data/investigations.json` con `fetch`.
- Instantánea observada: 307 contenidos y 3 investigaciones.
- Diez fuentes de Notion declaradas en `config/notion-sources.json`.
- Scripts Node.js 24 consultan Notion, normalizan propiedades y generan los JSON.
- GitHub Actions sincroniza cada 15 minutos, audita duplicados y hace commit/push.
- `NOTION_API_KEY` se mantiene como secreto de GitHub Actions.
- No hay `package.json`, dependencias de aplicación ni suite formal de pruebas.

El Knowledge Hub no se modificará durante las Fases 0–9. La futura integración se diseñará
como una exportación explícita y validada; nunca como escritura directa desde el frontend.

## 2. Clasificación de elementos existentes

| Elemento | Clasificación | Justificación |
|---|---|---|
| Repositorio público y rama `main` | NECESARIO | Producción y destino futuro |
| Contratos `content.json` e `investigations.json` | NECESARIO | Interfaz de compatibilidad observable |
| Scripts de sincronización Notion | ÚTIL | Referencia para normalización y publicación |
| Auditoría de identificadores | ÚTIL | Base para validación previa a publicación |
| IDs estables `id`/`notionId` | ÚTIL | Facilitan enlaces y deduplicación |
| Notion como fuente del Hub actual | ÚTIL | Fuente existente, no dependencia del Research Engine |
| Panel de investigaciones del HTML | ÚTIL | Prototipo conceptual, no sistema persistente |
| Formulario de propuestas en memoria | DUDOSO | No tiene persistencia, identidad ni controles de abuso |
| Inteligencia calculada en cliente | DUDOSO | Heurística de presentación, no investigación validada |
| `index.html` monolítico | OBSOLETO para el nuevo sistema | No debe reutilizarse como arquitectura de aplicación |
| Datos externos insertados con `innerHTML` | PELIGROSO | Riesgo potencial de XSS persistente |
| Workflow con `contents: write` y push directo | PELIGROSO | Amplio permiso sobre producción; requiere endurecimiento futuro |
| Frontend con permisos directos de GitHub | PROHIBIDO | Viola el límite de seguridad del proyecto |

No se propone eliminar ni modificar ningún elemento del Knowledge Hub en esta fase.

## 3. Principios y límites

1. **Participation** recoge aportaciones; no declara verdad.
2. **Research** solo se ejecuta tras una autorización válida y consume presupuestos limitados.
3. **Knowledge** contiene resultados revisados y publicables.
4. El estado transaccional se materializa; un registro de eventos inmutable aporta auditoría.
5. El Research Engine es independiente de Notion y del repositorio público.
6. Ningún umbral, score o apoyo inicia IA automáticamente.
7. Las integraciones externas se ejecutan desde servicios privados con privilegio mínimo.
8. Las transiciones críticas son idempotentes y transaccionales.

## 4. Componentes propuestos

```text
Usuarios / Administradores
          |
          v
   Web UI / Admin UI
          |
          v
 API de Participation y Administración
          |
          +--------------------+
          |                    |
          v                    v
 Base transaccional       Event Log append-only
          |                    |
          +------> Outbox -----+
                     |
                     v
               Job Queue/Worker
                     |
       autorización válida + presupuesto
                     |
                     v
              Research Orchestrator
               |       |       |
             Search  Fetch   Model gateway
               \       |       /
                resultados/citas
                     |
                     v
             Validation workflow
                     |
                     v
             Publication Exporter
                     |
             artefacto versionado
                     |
      integración futura con Knowledge Hub
```

### Módulos

- **Public API:** propuestas, apoyos, fuentes y evidencias; validación y rate limiting.
- **Admin API:** moderación, autorización, cancelación y validación; autenticación reforzada.
- **Domain service:** reglas de estado, permisos, scores y autorizaciones.
- **Persistence:** base relacional, migraciones y concurrencia optimista.
- **Event log + outbox:** historial inmutable y entrega fiable sin imponer event sourcing puro.
- **Queue/worker:** trabajos independientes, reintentos acotados e idempotencia.
- **Research orchestrator:** planifica pasos sujetos a presupuesto y condición de parada.
- **Provider adapters:** búsqueda, obtención de documentos y modelos detrás de interfaces.
- **Validation:** revisión humana, conflictos, calidad de citas y decisión de publicación.
- **Exporter:** crea un contrato de intercambio; no escribe en producción en esta etapa.
- **Observability:** logs estructurados, métricas, trazas y alertas sin datos innecesarios.

## 5. Modelo de datos conceptual

Todos los registros mutables incluyen `id`, `created_at`, `updated_at` y una versión de
concurrencia. Los identificadores públicos son opacos.

### Proposal

- título, pregunta central, descripción, autor pseudónimo
- estado, visibilidad y motivo de cierre
- score de prioridad materializado y versión de fórmula
- contadores materializados de apoyo/evidencia
- revisión de moderación y timestamps de estado

### Event

- agregado, `aggregate_id`, tipo, versión y secuencia
- actor pseudónimo/tipo de actor
- payload versionado, correlation/causation ID y timestamp del servidor
- hash opcional de integridad

Append-only por la aplicación; correcciones mediante eventos compensatorios.

### Source

- URL canónica o referencia documental
- metadatos, tipo, idioma, fecha y procedencia
- hash de contenido, estado de obtención y evaluación de calidad
- aportante pseudónimo; el contenido bruto se separa y limita

### Claim

- afirmación atómica, alcance, sujeto y contexto
- origen (usuario, fuente o investigación)
- clasificación propuesta: `FACT`, `CLAIM`, `INFERENCE`, `UNCERTAINTY`

### Evidence

- `claim_id`, `source_id`, fragmento/localizador y contexto
- postura: `SUPPORTS`, `CONTRADICTS`, `CONTEXTUALIZES`, `UNKNOWN`
- evaluación de calidad, autor y estado de moderación

La fuente, la afirmación y la evidencia permanecen separadas y forman relaciones muchos a
muchos mediante evidencias.

### Support

- propuesta, actor pseudónimo, estado y timestamp
- clave anti-duplicado versionada
- señales antiabuso separadas y con retención limitada

Restricción única por propuesta y sujeto de participación vigente.

### Score

- propuesta, dimensión, valor, versión de fórmula
- entradas explicables, cálculo y timestamp

Dimensiones separadas:

- `PRIORITY`
- `PROGRESS`
- `CONFIDENCE`
- `SUPPORT_COUNT`

### Authorization

- propuesta, tipo (`ADMIN`, `PAYMENT`, `THRESHOLD`)
- estado, emisor, política y evidencia de autorización
- presupuesto máximo, vigencia, uso único/idempotency key
- revocación y motivo

`THRESHOLD_REACHED` solo crea elegibilidad; no una autorización implícita.

### ResearchJob

- propuesta y autorización
- estado, prioridad y versión del plan
- límites de coste, tiempo, llamadas y tokens
- consumo, lease del worker, intentos y condición de parada
- timestamps, error normalizado y solicitud de cancelación

### ResearchResult

- trabajo, versión, resumen y conclusión estructurada
- hechos, afirmaciones, inferencias, incertidumbres y conflictos separados
- citas y evidencias trazables
- limitaciones, cobertura, costes y métricas
- estado de validación y publicación

### Entidades auxiliares recomendadas

- `Actor`, `RoleAssignment`, `ModerationAction`
- `ProposalHistory` como vista derivada de eventos
- `ResearchStep`, `Citation`, `ValidationReview`
- `OutboxMessage`, `IdempotencyRecord`, `AbuseSignal`
- `ScorePolicy`, `AuthorizationPolicy`, `RetentionPolicy`

## 6. Modelo de eventos

Formato mínimo:

```json
{
  "eventId": "opaque-id",
  "eventType": "proposal_created",
  "eventVersion": 1,
  "aggregateType": "proposal",
  "aggregateId": "opaque-id",
  "sequence": 1,
  "occurredAt": "server-time",
  "actor": {"type": "user", "id": "pseudonymous-id"},
  "correlationId": "opaque-id",
  "payload": {}
}
```

Familias iniciales:

- Propuesta: `proposal_created`, `proposal_updated`, `proposal_opened`,
  `proposal_collecting`, `proposal_archived`, `proposal_rejected`,
  `proposal_deletion_requested`, `proposal_deleted`.
- Participación: `support_added`, `support_revoked`, `support_rejected`,
  `source_added`, `claim_added`, `evidence_added`, `counter_evidence_added`.
- Score: `score_recalculated`, `threshold_reached`, `threshold_lost`,
  `proposal_became_eligible`.
- Autorización: `authorization_created`, `authorization_revoked`,
  `authorization_expired`, `authorization_consumed`.
- Research: `research_job_created`, `research_job_queued`, `research_started`,
  `research_paused`, `research_resumed`, `research_cancel_requested`,
  `research_cancelled`, `research_completed`, `research_failed`.
- Validación: `result_submitted`, `result_validation_started`,
  `result_changes_requested`, `result_validated`, `result_rejected`,
  `publication_export_created`.
- Seguridad: eventos separados y restringidos para bloqueos y anomalías; nunca incluyen
  secretos ni IP sin minimizar.

Las escrituras de estado, evento y outbox ocurren en una sola transacción. Los consumidores
son idempotentes. La secuencia es estricta por agregado, no necesariamente global.

## 7. Ciclo de vida

### Proposal

```text
CREATED -> OPEN -> COLLECTING -> THRESHOLD_REACHED -> ELIGIBLE
   |         |          |                |              |
   +---------+----------+----------------+--------------+--> ARCHIVED
                               ELIGIBLE -> AUTHORIZED -> QUEUED
                                                        |
                                              RUNNING <-> PAUSED
                                                        |
                                           ANALYZING -> COMPLETED

Alternativas: REJECTED, DELETION_PENDING, DELETED, CANCELLED, FAILED
```

`THRESHOLD_REACHED` y `ELIGIBLE` no ejecutan investigación. `AUTHORIZED` requiere una
`Authorization` válida. `QUEUED` requiere además crear un `ResearchJob` de forma
transaccional e idempotente.

Conviene separar el estado de Proposal del estado de ResearchJob: una propuesta puede tener
varios trabajos versionados, fallidos o repetidos bajo autorizaciones distintas.

### ResearchJob

`CREATED -> QUEUED -> RUNNING <-> PAUSED -> COMPLETED`

Desde estados no terminales puede pasar a `CANCELLED`; desde ejecución puede pasar a
`FAILED`. Un reintento crea intento/step nuevo, no borra el error anterior.

### ResearchResult

`DRAFT -> SUBMITTED -> IN_REVIEW -> CHANGES_REQUESTED -> VALIDATED -> PUBLISHED`

Alternativas: `REJECTED`, `SUPERSEDED`, `WITHDRAWN`. La publicación futura es explícita.

## 8. Seguridad y privacidad

### Controles de acceso

- Usuarios anónimos/pseudónimos con capacidades limitadas y evolucionables.
- Administración con proveedor de identidad, MFA resistente al phishing, sesiones cortas y
  separación de roles: moderador, autorizador, validador y operador.
- Autorización comprobada en servidor y denegación por defecto.
- Acciones críticas con reautenticación, auditoría y protección CSRF.

### Antiabuso

- Límites por ruta, cuenta, seudónimo, red minimizada y globales.
- Cuotas más estrictas para creación, URLs y acciones costosas.
- CAPTCHA adaptativo, honeypots, reputación y detección de velocidad/anomalías.
- No se considera `1 IP = 1 persona`; la IP es una señal temporal, truncada o tokenizada.
- Idempotency keys, restricciones únicas y transacciones evitan duplicados.

### Entrada y fuentes

- Esquemas estrictos, límites de tamaño y normalización Unicode.
- Renderizado con escaping contextual y sanitizador con allowlist.
- URLs solo `http/https`; bloqueo de credenciales embebidas y hosts internos.
- Obtención remota aislada contra SSRF: resolución DNS validada, egress controlado,
  redirecciones limitadas, timeouts, tamaño y MIME comprobados.
- Documentos tratados como no confiables; análisis en sandbox y sin macros.
- El contenido de fuentes es dato, nunca instrucción de sistema.

### IA y costes

- La cola rechaza trabajos sin autorización vigente.
- Presupuesto inmutable por trabajo: dinero, tiempo, tokens, llamadas y volumen descargado.
- Deadlines, cancelación cooperativa, circuit breaker y profundidad máxima.
- Gateway único para proveedores; credenciales solo en backend.
- Tool allowlist, egress allowlist, protección frente a prompt injection y trazabilidad.
- Reserva y contabilización atómica del presupuesto antes de cada llamada.

### Secretos y observabilidad

- Secret manager por entorno; `.env` solo local y nunca versionado.
- Rotación, permisos mínimos y separación desarrollo/staging/producción.
- Logs estructurados con redacción; nunca prompts completos, tokens, cookies ni documentos
  privados por defecto.
- Alertas por picos de coste, fallos de autorización, fraude y cola bloqueada.

### Privacidad

- Separación entre identidad, participación y señales antiabuso.
- Minimización, cifrado en tránsito/reposo y retención por categoría.
- Borrado lógico sujeto a auditoría y borrado físico programado cuando proceda.
- Evaluación legal antes de pagos, perfiles, cookies no esenciales o datos sensibles.

## 9. Interfaces futuras con Knowledge Hub

El Research Engine debe producir un artefacto versionado, validado y de solo salida. Una
propuesta de contrato:

```json
{
  "schemaVersion": 1,
  "generatedAt": "server-time",
  "results": [
    {
      "id": "stable-id",
      "title": "string",
      "status": "validated",
      "centralQuestion": "string",
      "claims": [],
      "evidence": [],
      "conclusions": [],
      "uncertainties": [],
      "citations": []
    }
  ]
}
```

La integración de Fase 10 deberá decidir entre:

1. importación revisada por pull request;
2. endpoint de lectura autenticado consumido por un build;
3. exportación a Notion tras validación.

Se recomienda inicialmente un artefacto JSON versionado y una PR revisable: maximiza
trazabilidad, reversibilidad y aislamiento de producción.

## 10. Riesgos principales

| Riesgo | Impacto | Mitigación propuesta |
|---|---|---|
| XSS desde contenido sincronizado | Alto | Escape/sanitización y CSP antes de integración |
| Ejecución de IA no autorizada | Crítico | Guard transaccional y tests negativos obligatorios |
| Costes artificiales | Crítico | Cuotas, presupuestos atómicos y circuit breaker |
| SSRF/documentos maliciosos | Alto | Fetcher aislado y sandbox |
| Sybil/votos masivos | Alto | Modelo de señales múltiple y políticas versionadas |
| Complejidad prematura | Medio | Monolito modular inicial; interfaces internas |
| Pérdida de trazabilidad | Alto | Event log + outbox + estados materializados |
| Acoplamiento a Notion | Alto | Dominio y almacenamiento propios |
| Escritura accidental en producción | Crítico | Repositorios, secretos y pipelines separados |
| Fórmula de score manipulable | Alto | Dimensiones separadas, versión y explicación |
| Privacidad excesiva | Alto | Minimización y retención definida antes de capturar |
| Dependencia de proveedor IA | Medio | Gateway y contrato neutral |

## 11. Criterios arquitectónicos de éxito

- Ninguna acción de participación ejecuta IA.
- Solo una autorización válida puede crear un ResearchJob.
- Cada cambio importante produce estado consistente y evento auditable.
- Source, Claim y Evidence son entidades distintas.
- Priority, Progress, Confidence y Support Count no se mezclan.
- Los trabajos respetan y demuestran límites de coste y ejecución.
- El sistema funciona sin Notion ni permisos de escritura sobre el Knowledge Hub.
- La publicación requiere validación humana y es reversible.
- Los datos personales y secretos no aparecen en cliente, eventos ni logs.

