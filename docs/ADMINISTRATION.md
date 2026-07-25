# Administración y validación — Fase 7

## Frontera de identidad

La API administrativa acepta exclusivamente una identidad federada ya verificada por un
adaptador IdP inyectado. Ni el body ni los headers públicos pueden declarar actor, rol o MFA.
Las identidades deben preaprovisionarse y estar activas.

La creación de sesión exige MFA. Los tokens de acceso y CSRF son aleatorios y solo sus hashes
SHA-256 se conservan. PostgreSQL comprueba expiración y revocación. Toda mutación HTTP exige
el token de sesión y un token CSRF independiente.

El proveedor IdP real, sus claves de verificación y el enrolamiento MFA son adaptadores de
despliegue pendientes; el núcleo no almacena contraseñas ni secretos del proveedor.

## Separación de funciones

- `MODERATOR`: decide `ACCEPTED` o `REJECTED` para Source, Claim y Evidence.
- `POLICY_ADMIN`: activa conjuntos de políticas de score con MFA y reautenticación de menos
  de cinco minutos.
- `VALIDATOR`: consulta la cola de Proposals elegibles para revisión humana.

Los roles no son intercambiables. El servicio de activación vuelve a verificar sesión, rol,
MFA, vigencia y reautenticación dentro de su transacción; un contexto fabricado no basta.

## Auditoría

Moderación y activación escriben `administrative_action_audit`, evento de dominio y Outbox
dentro de la misma operación. La auditoría es append-only. Los motivos no se copian al Event
Log: solo se registra que existe un motivo, reduciendo retención de contenido administrativo.

## Límites deliberados

Esta fase no crea filas en `authorizations` ni `research_jobs`, no añade cola de ejecución,
no consume presupuesto y no ejecuta IA. La cola de elegibles es únicamente una vista de
revisión. El workflow de Authorization y Research Jobs pertenece a la Fase 8.
