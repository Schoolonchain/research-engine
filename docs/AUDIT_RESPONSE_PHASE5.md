# Respuesta a auditoría — Fase 5

Estado: segunda ronda de correcciones implementada; pendiente de reauditoría.

## Hallazgos bloqueantes

- **H-001:** la política IP rechaza IPv4-mapped IPv6 y rangos IPv4/IPv6 no globales; también
  rechaza respuestas DNS mixtas.
- **H-002:** cuotas persistentes, versionadas y por actor/global para Source, Claim y Evidence;
  agotamiento HTTP `429` con `Retry-After`.
- **H-003:** migración nueva con unicidad `NULLS NOT DISTINCT` para Evidence.

## Integridad y carreras

- La fila Proposal queda bloqueada `FOR SHARE` y la inserción vuelve a exigir estado abierto.
- Triggers impiden Claim–Source y Evidence–Claim–Source entre Proposals distintas.
- `idempotencyKey` es obligatorio, acotado y único por actor y tipo de entidad.
- Violaciones concurrentes de unicidad se traducen a conflicto de dominio.

## Cobertura

La suite incluye direcciones mapped/reservadas, DNS mixto, redirecciones, MIME/tamaño,
cuotas, unicidad con locator nulo e invariantes SQL. El transporte productivo permanece
formalmente bloqueado: no podrá activarse hasta demostrar pinning real a una IP validada,
timeout y límites de streaming en una auditoría específica.

No se añadió IA, ResearchJob, pagos, score ni integración con Knowledge Hub.

## Segunda ronda

- Clasificación separada: IPv4 pública permitida; IPv6 limitada a global unicast y sin
  prefijos mapped, transición, documentación o espacios no asignados.
- Casos positivos confirman que el transporte se invoca con IPv4 e IPv6 públicas.
- Reloj, ventana y `Retry-After` proceden de PostgreSQL.
- Purga acotada de hasta 1.000 contadores expirados por operación, respaldada por índice.
- Política de cuotas validada como enteros positivos y retención mayor o igual a ventana.
- `proposal_id` es inmutable en Source y Claim mediante migración nueva.
