# Fase 8 — Authorization y ResearchJob determinista

## Frontera autorizada

Fase 8 implementa exclusivamente permisos explícitos y trabajos simulados. No existe gateway
de IA, proveedor externo, consumo monetario, PAYMENT, publicación ni Research Engine.

## Authorization

`AuthorizationService.issue()` exige una sesión `VALIDATOR` viva, MFA y reautenticación
reciente dentro de la misma transacción. La Authorization captura el `scoreRunId` y
`policySetHash` vigentes del guard `current_proposal_eligibility`, tiene inicio, expiración,
presupuestos y una clave idempotente. Solo admite `ADMIN` y `THRESHOLD`; la migración `0022`
rechaza estructuralmente `PAYMENT`.

La emisión concurrente se serializa mediante un receipt append-only. Revocar requiere motivo,
es idempotente y bloquea la Authorization. Una Authorization consumida no puede revocarse.

## Consumo único

`ResearchJobService.createFromAuthorization()` bloquea la Authorization y vuelve a comprobar:

- estado `VALID` y ventana temporal;
- snapshot exacto de elegibilidad;
- `policySetHash` de la activación global más reciente;
- ausencia de un ResearchJob previo.

La FK única `research_jobs.authorization_id` y el bloqueo garantizan exactamente un job. Los
reintentos devuelven ese mismo job. Una rotación de política obliga a emitir otra Authorization.

## Cola, leases y límites

Los jobs nacen `QUEUED`. El claim usa `FOR UPDATE SKIP LOCKED`, recupera leases vencidos,
incrementa intentos y aplica `maxAttempts`, `availableAt` y `deadlineAt`. Solo el propietario
de un lease vigente puede completar o declarar fallo.

La finalización bloquea la fila y comprueba atómicamente llamadas, unidades de trabajo y coste.
Un exceso no consume presupuesto ni completa el job. Los reintentos admiten retrasos de 1–300
segundos y un máximo de diez intentos. Al agotarlos, el job queda `FAILED`.

La cancelación de jobs en cola es inmediata. En ejecución queda solicitada y el worker la
convierte en `CANCELLED` antes de persistir resultados.

## Ejecutor simulado

`DeterministicResearchExecutor` consume una llamada, una unidad de trabajo y coste cero.
Persiste exclusivamente un digest SHA-256 reproducible con `provider: null` y
`publication: false`. No accede a red, modelos, prompts, PAYMENT o Knowledge Hub.

## Consistencia de política en consumidores

El cursor de la cola elegible contiene `publicId`, `scoreRunId` y `policySetHash`. Continuar
después de una activación diferente falla con conflicto y obliga a reiniciar la paginación.
El consumo de Authorization aplica el mismo criterio y nunca mezcla snapshots de políticas.
