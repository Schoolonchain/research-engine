# Fase 8 — Authorization y ResearchJob determinista

## Frontera autorizada

Fase 8 implementa exclusivamente permisos explícitos y trabajos simulados. No existe gateway
de IA, proveedor externo, consumo monetario, PAYMENT, publicación ni Research Engine.

## Authorization

`AuthorizationService.issue()` exige una sesión `VALIDATOR` viva, MFA y reautenticación
reciente dentro de la misma transacción. `THRESHOLD` captura el `scoreRunId` y
`policySetHash` vigentes del guard `current_proposal_eligibility`. `ADMIN` es una excepción
humana explícita: puede omitir solo esa elegibilidad, pero exige justificación restringida y
registra actor, snapshot observado y política activa. Ambos tipos tienen inicio, expiración,
presupuestos y una clave idempotente. Solo admite `ADMIN` y `THRESHOLD`; la migración `0022`
rechaza estructuralmente `PAYMENT`.

La emisión concurrente se serializa mediante un receipt append-only. Revocar requiere motivo,
es idempotente por clave y por estado: repetir el mismo motivo no crea otro evento; intentar
cambiar el motivo ya persistido produce conflicto. Una Authorization consumida no puede revocarse.

## Consumo único

`ResearchJobService.createFromAuthorization()` bloquea la Authorization y vuelve a comprobar:

- estado `VALID` y ventana temporal;
- snapshot exacto de elegibilidad para `THRESHOLD` (la excepción `ADMIN` no lo exige);
- `policySetHash` de la activación global más reciente;
- ausencia de un ResearchJob previo.

La FK única `research_jobs.authorization_id` y el bloqueo garantizan exactamente un job. Los
reintentos devuelven ese mismo job. Una rotación de política obliga a emitir otra Authorization.

## Cola, leases y límites

Los jobs nacen `QUEUED`. El claim usa `FOR UPDATE SKIP LOCKED`, recupera leases vencidos,
incrementa intentos y aplica `maxAttempts`, `availableAt` y `deadlineAt`. Solo el propietario
de un lease vigente puede completar o declarar fallo.

La finalización y el fallo bloquean la fila y usan `clock_timestamp()` después del bloqueo para
rechazar respuestas tardías, leases vencidos y deadlines cruzados durante la ejecución. Comprueban
atómicamente llamadas, unidades de trabajo y coste. Cada intento, también fallido o cancelado,
registra su consumo en un ledger append-only. Un exceso no completa el job. Los reintentos admiten retrasos de 1–300
segundos y un máximo de diez intentos. Al agotarlos, el job queda `FAILED`.

La cancelación de jobs en cola es inmediata. En ejecución tiene precedencia sobre `complete` y
`fail`, incluso bajo carrera. Toda transición `COMPLETED`, `FAILED` o `CANCELLED`, incluidas las
de limpieza de leases/deadlines, escribe exactamente un evento y un mensaje Outbox atómicos.

## Ejecutor simulado

`DeterministicResearchExecutor` consume una llamada, una unidad de trabajo y coste cero.
Persiste exclusivamente el contrato cerrado `DETERMINISTIC_SIMULATION` con digest SHA-256,
`provider: null` y `publication: false`; rechaza campos extra, proveedores, publicación o digests
inválidos. No accede a red, modelos, prompts, PAYMENT o Knowledge Hub.

## Consistencia de política en consumidores

El cursor de la cola elegible contiene `publicId`, `scoreRunId` y `policySetHash`. Continuar
después de una activación diferente falla con conflicto y obliga a reiniciar la paginación.
El consumo de Authorization aplica el mismo criterio y nunca mezcla snapshots de políticas.
