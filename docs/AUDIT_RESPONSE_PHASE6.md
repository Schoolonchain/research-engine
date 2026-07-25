# Respuesta a auditoría — Fase 6

Estado: tercera ronda de correcciones implementada; pendiente de reauditoría.

- `score_policies` bloquea `DELETE`; una versión no puede borrarse y reutilizarse.
- `score_policy_activations` es append-only y comparte con su evento el `policySetHash`
  criptográfico del conjunto de cuatro definiciones.
- Evidence y contradicciones exigen el predicado efectivo completo de Claim, incluida la
  Source asociada a Claim cuando exista.

- Políticas inmutables mediante fingerprint; reutilizar versión incompatible falla.
- Registro `DRAFT` y activación interna transaccional retiran la versión anterior.
- ScoreService consume exclusivamente cuatro políticas activas y coherentes.
- Solo Source, Claim y Evidence moderadas `ACCEPTED` influyen; ACCEPTED significa moderada,
  no conocimiento validado.
- `score_runs` conserva snapshot inmutable de entradas, dimensiones, política y elegibilidad.
- Scores, `score_recalculated`, `threshold_reached`, `proposal_became_eligible` y Outbox
  comparten `scoreRunId` y una transacción.
- Lock de Proposal y condición versionada garantizan una única transición concurrente.
- Si una Proposal `ELIGIBLE` pierde umbral, únicamente revierte a `COLLECTING` y emite
  `threshold_lost`.
- Support Count se valida antes de convertir bigint a number.

No existen endpoints administrativos de políticas ni trabajo de Fase 7.

Las migraciones `0011`–`0013` presuponen tablas de Fase 6 vacías: la fase aún no está
integrada y se confirmó que no existen entornos persistentes. Si esa precondición cambiara,
haría falta un backfill explícito antes de aplicar los `NOT NULL`.

## Segunda ronda

- `definition_hash` es obligatorio; ScoreService recalcula y compara cada fingerprint activo.
- Trigger impide modificar dimensión, versión, definición, elegibilidad o fingerprint.
- `score_runs` y Scores históricos son append-only; `score_run_id` es obligatorio.
- Evidence solo cuenta si ella, su Claim y su Source están moderadas `ACCEPTED`.
- Claim asociada a Source solo cuenta cuando ambas están `ACCEPTED`; Claim sin Source depende
  de su propio estado.
- Cada activación crea `score_policy_activations`, `score_policy_activated` y Outbox dentro de
  la misma transacción.
- DRAFT representa registro-y-activación interna atómica en esta fase, no revisión separada.
