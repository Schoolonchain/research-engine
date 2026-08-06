# Administración y validación — Fase 7

## Frontera de identidad

La API administrativa acepta exclusivamente una identidad federada ya verificada por un
adaptador IdP inyectado. Ni el body ni los headers públicos pueden declarar actor, rol o MFA.
Las identidades deben preaprovisionarse y estar activas.

La creación de sesión exige MFA. Los tokens de acceso y CSRF son aleatorios y solo sus hashes
SHA-256 se conservan. PostgreSQL comprueba expiración y revocación. Toda mutación HTTP exige
el token de sesión y un token CSRF independiente.

Las sesiones se limitan a diez activas por identidad. Las expiradas o revocadas se purgan en
lotes después de 24 horas; la auditoría conserva el UUID histórico sin una FK que impida la
purga. Emisión y revocación producen entradas append-only sin guardar tokens.

El proveedor IdP real, sus claves de verificación, el enrolamiento MFA, el aprovisionamiento,
la suspensión y los cambios de rol pertenecen a la frontera IdP. Fase 7 no expone un servicio
ni un endpoint para modificar identidades y no introduce un rol `IDENTITY_ADMIN`.

## Separación de funciones

- `MODERATOR`: decide `ACCEPTED` o `REJECTED` para Source, Claim y Evidence.
- `POLICY_ADMIN`: activa conjuntos de políticas de score con MFA y reautenticación de menos
  de cinco minutos.
- `VALIDATOR`: consulta la cola de Proposals elegibles para revisión humana.

Los roles no son intercambiables. El servicio de activación vuelve a verificar sesión, rol,
MFA, vigencia y reautenticación dentro de su transacción; un contexto fabricado no basta.
Moderación y cola revalidan igualmente identidad, rol, MFA, vigencia y revocación dentro de
la misma transacción y bloquean las filas de autoridad durante la operación.

## Auditoría

Moderación y activación escriben `administrative_action_audit`, evento de dominio y Outbox
dentro de la misma operación. La auditoría es append-only. Los motivos no se copian al Event
Log: el evento usa `reasonProvided`; el texto se conserva exclusivamente en la tabla de
auditoría administrativa restringida.

Toda moderación, activación y revocación de sesión exige una
`Idempotency-Key`. Un recibo append-only liga identidad, operación, clave, hash de solicitud y
correlación. Repetir la misma solicitud no muta; reutilizar la clave con otro contenido falla.

## Vigencia de elegibilidad

Una entrada en la cola liga Proposal, `score_run`, `policySetHash` y `knowledge_revision`.
Solo aparece si el run fue elegible, su `policySetHash` coincide con la activación global más
reciente y la revisión de conocimiento coincide. Una activación no recorre ni modifica
Proposals: todos los consumidores rechazan el snapshot obsoleto mediante el hash global y el
siguiente recálculo actualiza individualmente cada Proposal. La moderación sí invalida la
Proposal afectada porque cambia su propia revisión de conocimiento.
La cola usa cursor opaco y límites de 1–100 elementos.

### Migración de Proposals elegibles previas

Las Proposals que ya estuvieran `ELIGIBLE` al aplicar `0021` conservan estado y versión, pero
sus referencias de snapshot nacen nulas. Por tanto quedan fail-closed fuera de la cola, sin
actualización masiva ni eventos sintéticos. Un recálculo individual con la política activa
rellena `scoreRunId`, `policySetHash` y `knowledgeRevision` y vuelve a hacerlas visibles si
continúan cumpliendo el umbral. El despliegue puede recorrerlas por lotes acotados después de
activar la versión deseada; ese backfill usa el servicio normal de scoring y es reanudable.

## Límites deliberados

Esta fase no crea filas en `authorizations` ni `research_jobs`, no añade cola de ejecución,
no consume presupuesto y no ejecuta IA. La cola de elegibles es únicamente una vista de
revisión. El workflow de Authorization y Research Jobs pertenece a la Fase 8.
