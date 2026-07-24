# Fuentes, afirmaciones y evidencias — Fase 5

## Modelo

`Source`, `Claim` y `Evidence` son entidades independientes:

- Source conserva procedencia y URL canónica.
- Claim contiene una afirmación atómica y su clasificación.
- Evidence relaciona una Claim con una Source y declara su postura.
- Ninguna contribución crea Authorization, ResearchJob ni ejecuta IA.

Solo se aceptan contribuciones para Proposals `OPEN` o `COLLECTING`. La identidad procede de
un autenticador inyectado y nunca de IDs incluidos en el body.

Cada escritura requiere `idempotencyKey` y está sujeta a contadores persistentes versionados
por actor y globales. Una clave repetida se rechaza como conflicto —no existe replay—. El
agotamiento responde `429` con `Retry-After` calculado desde el final de ventana por PostgreSQL.
Las operaciones purgan de forma acotada filas expiradas mediante un índice de retención.

## URL y deduplicación

Solo se admiten HTTP/HTTPS, sin credenciales ni puertos no estándar. Se normalizan host,
puerto, fragmento y parámetros; se eliminan parámetros de seguimiento conocidos. La URL
canónica es única dentro de cada Proposal.

## Fetch seguro

`SafeSourceFetcher` está aislado detrás de resolver y transporte inyectables. Antes de cada
petición, incluida cada redirección, canonicaliza, resuelve DNS y rechaza direcciones privadas,
loopback, link-local, multicast o inválidas. El transporte recibe las direcciones aprobadas,
timeout y límite de bytes; deberá fijar la conexión a una de ellas para impedir DNS rebinding.
IPv6 se trata de forma fail-closed: solo global unicast y con exclusiones versionadas para
espacios especiales IANA, documentación y mecanismos de transición.

Se permiten HTML, texto, JSON y PDF, hasta 1 MB y tres redirecciones. El transporte de
producción queda bloqueado hasta una auditoría específica que demuestre conexión fijada a la
IP validada, timeout real y corte de streaming al alcanzar el límite.

## Contenido hostil

Excerpt, statement y context son texto no confiable. Este módulo no renderiza HTML. Una UI
futura deberá aplicar escaping contextual y no interpretar markup aportado.

## API

| Método | Ruta | Acción |
|---|---|---|
| `POST` | `/proposals/:proposalId/sources` | Añadir URL |
| `POST` | `/proposals/:proposalId/claims` | Añadir Claim |
| `POST` | `/claims/:claimId/evidence` | Relacionar Evidence |

Los constructores Fastify existen para integración, pero no hay entrypoint desplegable.
Cada mutación produce evento minimizado y Outbox atómico, sin copiar URL ni contenido.
Triggers de base de datos impiden relaciones entre Proposals distintas y una restricción
`NULLS NOT DISTINCT` evita Evidence duplicada aunque `locator` sea nulo. `proposal_id` es
inmutable después de crear Source o Claim.
