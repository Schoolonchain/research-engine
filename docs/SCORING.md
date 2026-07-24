# Score y elegibilidad — Fase 6

## Dimensiones

- `PRIORITY`: combinación acotada de apoyo normalizado y cobertura de Evidence.
- `PROGRESS`: cobertura acumulada de Source, Claim y Evidence.
- `CONFIDENCE`: proporción de Evidence aceptada con penalización de contradicciones aceptadas.
- `SUPPORT_COUNT`: contador absoluto independiente; no se presenta como probabilidad.

Cada resultado conserva versión de política, entradas numéricas y explicación en un
`score_run` inmutable. Solo aportaciones moderadas `ACCEPTED` participan; esto no significa
que sean conocimiento validado. Rejected y Pending quedan excluidas.

Las políticas se registran como DRAFT mediante un servicio interno y se activan
transaccionalmente, retirando la versión anterior. La definición y los umbrales quedan
ligados a un fingerprint obligatorio, verificado también al consumir. En Fase 6, DRAFT es un
estado técnico dentro de registro-y-activación atómicos, no una revisión humana separada.
Cada activación genera evento y Outbox.

Evidence participa únicamente si ella, su Claim y su Source están `ACCEPTED`. Una Claim sin
Source puede participar por su propio estado. Snapshots y Scores históricos son append-only.

## Elegibilidad

La política inicial exige simultáneamente mínimos de Priority, Progress, Confidence y apoyos.
Cuando se cumplen, se registran `threshold_reached` y `proposal_became_eligible`. Si una
Proposal `ELIGIBLE` deja de cumplirlos, emite `threshold_lost` y vuelve exclusivamente a
`COLLECTING`. Todos comparten snapshot, correlación y transacción. Este estado:

- no crea Authorization;
- no crea ResearchJob;
- no inicia IA, fetch ni trabajo externo;
- solo habilita una futura revisión humana en fases posteriores.

## Límites

Los scores se acotan a `[0,1]`, salvo `SUPPORT_COUNT`. Las políticas se validan y versionan.
Una política nueva produce una serie distinta y no sobrescribe el significado histórico.
