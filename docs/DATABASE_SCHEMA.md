# Modelo de datos — Fases 1–4

Fuentes ejecutables:

- `migrations/0001_initial_domain.sql`
- `migrations/0002_events_outbox.sql`
- `migrations/0003_participation_controls.sql`
- `migrations/0004_participation_key_rotation.sql`

## Agregados principales

```text
Actor
  |
  +--> Proposal
         |--> Source --> Evidence <-- Claim
         |                 ^
         +--> Claim -------+
         |--> Support
         |--> Score --> ScorePolicy
         |
         +--> Authorization --> ResearchJob --> ResearchResult

AggregateStream --> DomainEvent --> OutboxMessage
                         |
                         +--> ConsumerReceipt --> AggregateEventCount
```

## Identidad y concurrencia

- Las entidades expuestas en el futuro cuentan con `public_id` opaco separado de la PK.
- Los IDs son UUID generados por PostgreSQL.
- Los agregados mutables incluyen un entero `version` para concurrencia optimista.
- Los timestamps provienen de la base de datos.
- No existe `notionId`: el dominio funciona sin Notion.

## Entidades

### actors

Identidad técnica mínima y separada de señales antiabuso. No almacena IP, correo ni perfil
personal en esta fase.

### proposals

Pregunta y descripción aportadas, estado propio, visibilidad y contadores materializados.
Sus estados no incluyen `RUNNING` ni `FAILED`: esos pertenecen a ResearchJob.

### sources

Referencia aportada a una URL, documento o contexto. Se conserva la URL original y, cuando
proceda, una forma canónica deduplicable por propuesta.

### claims

Afirmación atómica clasificada como FACT, CLAIM, INFERENCE o UNCERTAINTY. Puede originarse
en una Source, pero continúa siendo una entidad independiente.

### evidence

Relación entre Claim y Source con postura SUPPORTS, CONTRADICTS, CONTEXTUALIZES o UNKNOWN,
localizador, fragmento y evaluaciones separadas.

### supports

Participación sobre una Proposal. `subject_key_hash` es una clave pseudónima derivada por una
clave HMAC identificada por `subject_key_id`; no supone que una IP sea una persona. Un índice
parcial impide dos apoyos activos para la misma propuesta y sujeto. Durante una rotación, el
servicio compara todas las versiones activas del keyring y migra perezosamente el apoyo a la
clave primaria.

### score_policies y scores

La fórmula se representa como política versionada. Cada resultado conserva dimensión,
entradas y explicación. PRIORITY, PROGRESS, CONFIDENCE y SUPPORT_COUNT son independientes.

### authorizations

Permiso acotado por tipo, vigencia, presupuesto e idempotency key. La validez de negocio y
su consumo atómico se implementarán en Fase 8; el esquema ya impide presupuestos negativos,
vigencias invertidas y reutilizar una autorización en varios trabajos.

### research_jobs

Trabajo independiente con estado, límites y consumo observado. El esquema impide que
coste, llamadas o tokens consumidos superen el presupuesto almacenado.

La tabla no ejecuta nada por sí misma. No hay cola, worker ni servicio creador en Fase 1.

### research_results

Resultado versionado con FACTS, CLAIMS, INFERENCES, UNCERTAINTIES,
CONFLICTING_EVIDENCE y CITATIONS separados en documentos JSON.

## Integridad comprobada

Los tests ejecutan la migración sobre PostgreSQL embebido y comprueban:

1. creación de las veinte tablas previstas;
2. segunda ejecución idempotente;
3. relaciones separadas Source–Claim–Evidence;
4. rechazo de apoyos activos duplicados;
5. persistencia independiente de las cuatro dimensiones de score;
6. una sola ResearchJob por Authorization;
7. límites estructurales de consumo;
8. ausencia de identificadores específicos de Notion.

## Tablas de eventos y procesamiento

### aggregate_streams

Contador de secuencia por tipo/ID de agregado. Permite compare-and-increment transaccional y
detecta escritores obsoletos.

### domain_events

Envelope append-only, versionado y ordenado por agregado. Triggers bloquean alteración y
borrado.

### outbox_messages

Referencia entregable al evento con estado, intentos, disponibilidad y lease. El payload no se
duplica.

### consumer_receipts

Clave única consumidor/evento para hacer idempotente el efecto de cada consumidor.

### aggregate_event_counts

Proyección mínima usada para demostrar reentrega segura y orden de procesamiento.

### participation_rate_limits

Contadores por ventana y scope `SUBJECT`, `NETWORK` o `GLOBAL`. Solo conserva claves HMAC,
límite aplicado y expiración. `policy_version` forma parte de la clave primaria para que un
cambio de política no reutilice contadores creados bajo parámetros anteriores.

### participation_subject_locks

Bloqueo lógico estable por sujeto, derivado con la clave más antigua aún activa del keyring.
Serializa altas, revocaciones y migraciones perezosas durante la rotación sin almacenar
identidad directa. La clave antigua solo puede retirarse cuando no queden apoyos activos ni
ventanas vigentes que dependan de ella.

### abuse_signals

Señales minimizadas y temporales generadas al exceder límites. No almacena IP, sujeto ni
identidad directa.

## Límites deliberados

- Servicios de Proposal pertenecen a Fase 3.
- Obtención segura de URLs pertenece a Fase 5.
- Cálculo de score pertenece a Fase 6.
- Autenticación administrativa pertenece a Fase 7.
- Guard transaccional de autorización y cola pertenecen a Fase 8.
- Orquestación e IA pertenecen a Fase 9.

