# Respuesta a auditoría — Fase 5

Estado: correcciones implementadas; pendiente de reauditoría.

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
