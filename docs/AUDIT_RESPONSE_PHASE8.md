# Respuesta correctiva de auditoría — Fase 8

La PR #16 permanece Draft. No se integra y no inicia la Fase 9.

## HIGH

- **H-001:** lease y deadline se validan con reloj de base de datos después del bloqueo; una
  respuesta vencida o tardía no puede cerrar un job reasignado.
- **H-002:** el deadline cruzado durante ejecución termina en `FAILED/DEADLINE_EXCEEDED` y conserva
  el consumo declarado.
- **H-003:** la cancelación tiene precedencia transaccional sobre `complete()` y `fail()`.
- **H-004:** cada intento fallido registra y acumula llamadas, unidades y coste en un ledger
  append-only; los reintentos no reinician presupuestos.
- **H-005:** todas las transiciones terminales, incluidas las de limpieza, producen evento y
  Outbox dentro de la misma transacción.

## Segunda ronda correctiva

- **H-001:** cada claim crea una generación `leaseToken` intransferible. `workerId` ya no basta;
  un token de un intento anterior falla aunque el mismo worker reclame el siguiente.
- **H-005:** el consumo crea `authorization_consumed` y Outbox exactamente una vez, atómicamente
  con el ResearchJob y `research_job_created`.
- **M-003:** grants, historia, motivo y todos los timestamps de una Authorization terminal quedan
  congelados ante cualquier `UPDATE` o `DELETE`.
- **M-005:** la idempotencia de emisión se acota por actor; dos actores que compiten con el mismo
  texto de clave reciben Authorizations independientes, sin colisión ni filtración cruzada.
- **M-006:** esta respuesta conserva los identificadores originales de auditoría; no reasigna el
  ID de un hallazgo a otra corrección.
- **M-007:** `leaseExpiresAt` queda acotado estructuralmente y en el claim por `deadlineAt`.

## Tercera ronda dirigida

- **H-004:** `usage` es obligatorio en `fail()` y cada lease entrega `remainingCalls`,
  `remainingTokens` y `remainingCostMinor`, calculados desde el consumo acumulado. La prueba de
  dos intentos demuestra que el fallo del primero reduce el presupuesto visible del segundo.
- **M-003:** cerrado completamente mediante inmutabilidad total de filas terminales; motivo,
  `consumed_at`, `revoked_at`, `created_at`, `updated_at`, vigencia y grant no pueden reescribirse.
- **M-006:** cerrado documentalmente manteniendo H-001, H-004, H-005, M-003, M-005, M-006 y
  M-007 asociados a sus hallazgos originales.

## MEDIUM

- **M-001:** el output tiene un esquema cerrado, determinista y sin proveedor/publicación.
- **M-002:** la revocación repetida con el mismo motivo no duplica estado ni eventos; un motivo
  diferente entra en conflicto.
- **M-003:** `ADMIN` aplica la decisión humana: omite solo la elegibilidad y exige actor,
  justificación, snapshot observado y política activa; `THRESHOLD` conserva el guard vigente.
- **M-004:** el consumo de Authorization vuelve a comprobar reloj y política activa dentro de la
  misma transacción; `THRESHOLD` vuelve a comprobar además su snapshot elegible.
- **M-005:** los tests adversariales cubren respuesta tardía, deadline, carrera cancelar/fallar,
  consumos fallidos, terminales/Outbox, outputs inválidos y revocaciones repetidas.

La implementación sigue siendo una simulación determinista. IA, proveedores, PAYMENT,
publicación y Research Engine de Fase 9 continúan fuera de alcance.
