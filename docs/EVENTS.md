# Eventos, auditoría y Outbox — Fase 2

## Objetivo

Preservar historial verificable y permitir procesamiento asíncrono fiable sin convertir el
sistema en event sourcing puro. El estado transaccional continúa siendo la fuente de consulta
principal.

## Escritura atómica

`EventStore.transact(command, mutateState)` ejecuta en una sola transacción:

1. la mutación del estado materializado;
2. el avance de secuencia del agregado;
3. la inserción del evento;
4. la inserción del mensaje Outbox.

Si falla cualquiera de los pasos, todos se revierten. El escritor debe proporcionar
`expectedSequence`; una secuencia obsoleta produce `EventConcurrencyError`.

```text
BEGIN
  mutate current state
  compare-and-increment aggregate sequence
  append domain event
  append outbox reference
COMMIT
```

## Event envelope

Cada evento contiene:

- UUID proporcionado por el comando para reintentos deterministas;
- tipo y versión del evento;
- tipo, ID y secuencia del agregado;
- actor pseudónimo opcional;
- correlation ID obligatorio y causation ID opcional;
- payload JSON versionable;
- timestamps de ocurrencia y registro asignados por PostgreSQL.

La secuencia es estricta por agregado. No se promete un orden global entre agregados.

## Inmutabilidad

`domain_events` es append-only:

- PK por `event_id`;
- unicidad por agregado y secuencia;
- triggers rechazan `UPDATE` y `DELETE`;
- correcciones futuras deben expresarse con eventos compensatorios.

La aplicación no reconstruye todas las entidades desde eventos para responder consultas.

## Política de payload

Antes de abrir una transacción se rechazan:

- payloads superiores a 64 KiB;
- claves que indiquen contraseñas, secretos, tokens, cookies o credenciales;
- correo, IP, sesión y cabeceras de autorización directas.

Los eventos deben contener identificadores opacos y hechos mínimos. Esta defensa no sustituye
los esquemas allowlist específicos que se añadirán con cada familia funcional.

## Outbox

`outbox_messages` referencia el evento sin duplicar su payload.

Estados:

```text
PENDING -> PROCESSING -> PUBLISHED
               |
               +------> FAILED -> PROCESSING
```

La reclamación:

- usa `FOR UPDATE SKIP LOCKED`;
- asigna propietario y vencimiento del lease;
- incrementa intentos;
- recupera leases vencidos;
- impide que otro worker complete un mensaje que no posee.

Un fallo programa `available_at` con retraso explícito. El backoff y límite máximo de intentos
se definirán junto al proceso operativo que publique mensajes; no hay worker en Fase 2.

## Consumidores idempotentes

`IdempotentEventConsumer` inserta un recibo único por consumidor/evento en la misma
transacción que la proyección:

```text
BEGIN
  insert consumer receipt (on conflict: duplicate)
  update projection
COMMIT
```

Si el handler falla, el recibo también se revierte y la reentrega puede procesarse. Si ya
existe, la reentrega devuelve `DUPLICATE` y no repite efectos.

`aggregate_event_counts` es una proyección mínima de verificación, no una función de producto.

## Garantías verificadas

- orden estricto por agregado;
- streams independientes;
- detección de escritor obsoleto;
- rollback de estado cuando falla el append;
- un mensaje Outbox por evento;
- rechazo de alteración o borrado del historial;
- rechazo de payloads sensibles;
- procesamiento exactamente una vez a nivel de efecto de consumidor;
- rollback de recibo tras fallo;
- exclusión mutua mediante lease;
- rechazo de completion por worker ajeno;
- reintento solo después de `available_at`.

## Límites

- No hay endpoints ni comandos funcionales de Proposal.
- No existe un worker en ejecución ni broker externo.
- No hay publicación a Knowledge Hub.
- No hay autenticación, pagos ni IA.
- La proyección de ejemplo no toma decisiones de negocio.

