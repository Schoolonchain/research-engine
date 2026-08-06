# Respuesta correctiva — Fase 7

Estado: correcciones implementadas en la PR #15; pendiente de reauditoría.

- `moderate()` y `listEligible()` revalidan y bloquean sesión, identidad, rol, MFA, vigencia
  y revocación dentro de la misma transacción.
- La cola exige coincidencia entre Proposal, score run elegible, última activación,
  `policySetHash` y `knowledgeRevision`.
- Moderación y activación invalidan snapshots elegibles; un recálculo prueba pérdida o nueva
  adquisición de elegibilidad.
- Las activaciones usan un lock global y `activation_sequence`; las pruebas concurrentes
  verifican la cadena `previous_policy_version`.
- El motivo se conserva solo en auditoría restringida y el evento declara
  `reasonProvided`, nunca `reasonRecorded`.
- Moderación, activación, revocación de sesión y cambios de identidad usan recibos
  idempotentes append-only.
- Emisión/revocación de sesiones y cambios de identidad tienen auditoría segura.
- Las sesiones están acotadas y se purgan por lotes; la cola tiene cursor opaco.
- La API mantiene respuestas 400 y 413 diferenciadas.
- No se crea Authorization, ResearchJob, ejecución, cola de trabajo ni funcionalidad de Fase 8.

Verificación local correctiva: 613 tests aprobados y 9 integraciones externas omitidas;
typecheck, build y `git diff --check` aprobados. La ejecución CI se documentará sobre el SHA
publicado.
