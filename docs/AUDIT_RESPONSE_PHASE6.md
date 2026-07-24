# Respuesta a auditoría — Fase 6

Estado: correcciones implementadas; pendiente de reauditoría.

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
