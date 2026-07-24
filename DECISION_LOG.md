# Research Engine — Registro de decisiones

Este registro contiene decisiones, interpretaciones y cuestiones abiertas. Una decisión
propuesta no se considera aprobada hasta recibir confirmación humana.

## D-001 — Separar Research Engine del Knowledge Hub

- Fecha: 2026-07-24
- Estado: ACEPTADA POR RESTRICCIÓN DEL PROYECTO
- Decisión: desarrollar en un repositorio privado independiente.
- Motivo: aislar producción, secretos, experimentos y ciclos de despliegue.
- Consecuencia: la integración futura requiere un contrato explícito.

## D-002 — Tratar `Schoolonchain/knowledg_hub` como producción

- Fecha: 2026-07-24
- Estado: ACEPTADA POR RESTRICCIÓN DEL PROYECTO
- Decisión: solo lectura hasta autorización expresa de Fase 10.
- Evidencia: repositorio público activo, rama `main`, sincronización automatizada.
- Consecuencia: la copia local es únicamente referencia y no se enviarán cambios.

## D-003 — Usar estado materializado más Event Log y Outbox

- Fecha: 2026-07-24
- Estado: PROPUESTA
- Decisión: no adoptar event sourcing puro; guardar estado transaccional y eventos append-only.
- Motivo: trazabilidad sin complejidad innecesaria.
- Consecuencia: estado, evento y outbox deben escribirse atómicamente.

## D-004 — Mantener Participation, Research y Knowledge como límites

- Fecha: 2026-07-24
- Estado: PROPUESTA
- Decisión: aplicar límites modulares dentro de un monolito modular inicial.
- Motivo: preservar separación conceptual evitando microservicios prematuros.
- Consecuencia: interfaces internas claras y posibilidad de extracción futura.

## D-005 — Separar Source, Claim y Evidence

- Fecha: 2026-07-24
- Estado: PROPUESTA
- Decisión: una Source no es una afirmación ni prueba por sí sola.
- Motivo: permitir muchas afirmaciones por fuente y evidencias cruzadas.
- Consecuencia: modelo relacional adicional y resultados más auditables.

## D-006 — Separar dimensiones de score

- Fecha: 2026-07-24
- Estado: PROPUESTA
- Decisión: Priority, Progress, Confidence y Support Count se almacenan por separado.
- Motivo: evitar significado ambiguo y hacer fórmulas explicables/versionables.

## D-007 — El umbral crea elegibilidad, no autorización

- Fecha: 2026-07-24
- Estado: ACEPTADA POR RESTRICCIÓN DEL PROYECTO
- Decisión: `threshold_reached` no crea ni ejecuta un ResearchJob.
- Consecuencia: se necesita una Authorization válida y consumible.

## D-008 — Separar estado de Proposal y ResearchJob

- Fecha: 2026-07-24
- Estado: PROPUESTA
- Decisión: no comprimir ambos ciclos de vida en una única columna.
- Motivo: una propuesta puede generar varios trabajos e intentos.

## D-009 — Publicación mediante artefacto versionado

- Fecha: 2026-07-24
- Estado: PROPUESTA
- Decisión: producir JSON validado y, inicialmente, integrarlo mediante PR revisable.
- Motivo: reversibilidad, contract testing y ausencia de escritura directa.

## D-010 — Entorno privado local provisional

- Fecha: 2026-07-24
- Estado: TEMPORAL
- Decisión: usar el repositorio Git local vacío como entorno de planificación.
- Motivo: no existe un remoto privado accesible y el plugin no permite crear uno.
- Consecuencia: no hacer push hasta configurar y verificar un remoto privado.

## D-011 — No seleccionar stack durante Fase 0 sin aprobación

- Fecha: 2026-07-24
- Estado: ACEPTADA EL 2026-07-24
- Decisión: TypeScript estricto sobre Node.js 24, monolito modular y PostgreSQL.
- Implementación de Fase 1: SQL explícito, adaptador `pg` y migraciones propias con checksum.
- Alternativas:
  - Python/FastAPI + PostgreSQL: buena opción si domina el trabajo de investigación/ML.
  - TypeScript + PostgreSQL: contratos compartidos y ecosistema web homogéneo.
- Consecuencia: la plataforma de despliegue sigue pendiente, pero no bloquea el modelo.

## D-012 — Pagos fuera del MVP

- Fecha: 2026-07-24
- Estado: ACEPTADA EL 2026-07-24
- Decisión: implementar primero autorización administrativa y por política; diferir
  pagos hasta definir proveedor, reembolsos, fraude, fiscalidad y privacidad.
- Consecuencia: no bloquea propuestas, evidencias, scores ni Research Jobs autorizados por
  otros mecanismos.

## D-013 — Riesgo de renderizado en Knowledge Hub

- Fecha: 2026-07-24
- Estado: RIESGO REGISTRADO; CAMBIO NO AUTORIZADO
- Observación: campos sincronizados desde Notion se insertan repetidamente con `innerHTML`.
- Recomendación futura: escaping contextual, sanitizador con allowlist y CSP.
- Consecuencia: debe resolverse antes de aceptar contenido menos confiable del Research Engine.

## Decisiones humanas pendientes

| ID | Decisión | Recomendación | Bloquea |
|---|---|---|---|
| P-001 | Remoto privado `owner/repo` | `Schoolonchain/research-engine`, privado | Publicación/CI, no planificación |
| P-002 | Stack de aplicación | TypeScript + PostgreSQL, monolito modular | Fase 1 |
| P-003 | Hosting y regiones | Servicios administrados en región aplicable | Infraestructura |
| P-004 | Identidad de participantes | Pseudónimo/cuenta opcional, modelo evolutivo | Fase 4 |
| P-005 | Roles autorizadores/validadores | Separación de funciones | Fases 7–8 |
| P-006 | Política de umbral | Versionada y revisable | Fase 6 |
| P-007 | Pagos en MVP | Excluir | Parte PAYMENT de Fase 8 |
| P-008 | Jurisdicción y retención | Definir antes de datos reales | Producción |
| P-009 | Proveedores de búsqueda/IA y presupuesto | Evaluar en Fase 9 | Ejecución IA |
| P-010 | Método de integración | JSON + PR revisable | Fase 10 |

## D-014 — Migraciones SQL explícitas y verificadas con PGlite

- Fecha: 2026-07-24
- Estado: ACEPTADA EN FASE 1
- Decisión: mantener el esquema fuente en migraciones SQL PostgreSQL, sin ORM.
- Motivo: control visible de constraints, índices parciales, JSONB y transacciones.
- Verificación: ejecutar la migración real en PGlite durante tests.
- Consecuencia: una migración aplicada es inmutable; los cambios requieren una nueva versión.

## D-015 — Scripts de dependencias denegados salvo allowlist

- Fecha: 2026-07-24
- Estado: ACEPTADA EN FASE 1
- Decisión: pnpm solo permite el script de instalación de `esbuild`.
- Motivo: reducir riesgo de cadena de suministro manteniendo operativas las herramientas.
- Consecuencia: cualquier paquete futuro con scripts requiere revisión y decisión explícita.

## D-016 — La presencia de ResearchJob no habilita ejecución

- Fecha: 2026-07-24
- Estado: ACEPTADA EN FASE 1
- Decisión: modelar límites y relaciones ahora, sin crear servicio, cola ni worker.
- Motivo: continuidad del esquema sin violar el gate de Fase 8.
- Consecuencia: ninguna acción puede crear o ejecutar trabajos en Fase 1.
