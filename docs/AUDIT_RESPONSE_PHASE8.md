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
