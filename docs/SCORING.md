# Score y elegibilidad — Fase 6

## Dimensiones

- `PRIORITY`: combinación acotada de apoyo normalizado y cobertura de Evidence.
- `PROGRESS`: cobertura acumulada de Source, Claim y Evidence.
- `CONFIDENCE`: proporción de Evidence aceptada con penalización de contradicciones aceptadas.
- `SUPPORT_COUNT`: contador absoluto independiente; no se presenta como probabilidad.

Cada resultado conserva versión de política, entradas numéricas y explicación. El recálculo
es idempotente para Proposal, dimensión y política.

## Elegibilidad

La política inicial exige simultáneamente mínimos de Priority, Progress, Confidence y apoyos.
Cuando se cumplen, la Proposal pasa a `ELIGIBLE` y se registra
`proposal_became_eligible`. Este estado:

- no crea Authorization;
- no crea ResearchJob;
- no inicia IA, fetch ni trabajo externo;
- solo habilita una futura revisión humana en fases posteriores.

## Límites

Los scores se acotan a `[0,1]`, salvo `SUPPORT_COUNT`. Las políticas se validan y versionan.
Una política nueva produce una serie distinta y no sobrescribe el significado histórico.
