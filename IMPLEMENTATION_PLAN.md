# Research Engine — Plan de implementación

Estado: propuesta de Fase 0, pendiente de aprobación humana  
Fecha: 2026-07-24

## Reglas de ejecución

Cada fase requiere: objetivo, cambios, tests, verificación, documentación y resultado.
La aprobación de una fase no autoriza la siguiente. No se ejecutarán pagos, IA con coste,
producción ni integración pública sin autorización específica.

## Fase 0 — Inspección y arquitectura

### Objetivo

Entender el Knowledge Hub, delimitar el nuevo sistema y producir un plan verificable.

### Resultado

- Knowledge Hub público inspeccionado sin cambios.
- Entorno privado local identificado; remoto privado aún pendiente.
- Arquitectura, datos, eventos, estados, seguridad, riesgos y decisiones documentados.

### Verificación

- Solo se añadieron documentos de planificación al repositorio local.
- No se implementó funcionalidad.
- No se modificó, publicó ni configuró el repositorio público.

### Gate

Orden explícita requerida: **“Plan aprobado. Comienza con la Fase 1.”**

## Fase 1 — Fundación y modelo de datos

**Estado: COMPLETADA LOCALMENTE EL 2026-07-24; pendiente de checkpoint humano.**

### Objetivo

Crear el esqueleto técnico y el esquema persistente sin endpoints de producto.

### Cambios propuestos

- Seleccionar stack mediante ADR.
- Configurar repositorio privado remoto, protección de rama y CI mínimo.
- Estructura de monolito modular y configuración por entornos.
- Base relacional y migraciones para Proposal, Source, Claim, Evidence, Support, Score,
  Authorization, ResearchJob y ResearchResult.
- Restricciones, claves, timestamps, borrado y versionado de concurrencia.
- Datos de prueba no sensibles.

### Tests

- Migración desde cero, rollback seguro cuando proceda y upgrade.
- Restricciones de unicidad, claves y estados.
- Ningún secreto versionado.
- Modelo independiente de Notion.

### Criterio de éxito

Esquema reproducible, documentado y validado en CI; sin flujo funcional expuesto.

### Resultado verificado

- Stack fijado: TypeScript estricto sobre Node.js 24 y PostgreSQL.
- Migración `0001_initial_domain.sql` con doce tablas de dominio/control.
- Runner transaccional con checksum e idempotencia.
- Configuración validada y secretos locales excluidos.
- Lockfile y allowlist de scripts de instalación.
- CI con permisos de solo lectura.
- 10 tests pasan sobre PostgreSQL embebido.
- Typecheck y build pasan.
- No se crearon endpoints, cola, worker, autenticación ni integración con IA.

### Gate

Orden explícita requerida: **“Fase 1 aprobada. Comienza con la Fase 2.”**

## Fase 2 — Eventos, auditoría y outbox

**Estado: COMPLETADA LOCALMENTE EL 2026-07-24; pendiente de checkpoint humano.**

### Objetivo

Preservar historial y entrega fiable sin event sourcing puro.

### Cambios propuestos

- Event envelope versionado y secuencia por agregado.
- Escritura transaccional de estado + evento + outbox.
- Consumidores idempotentes y proyecciones básicas.
- Política de redacción y retención.

### Tests

- Orden por agregado, inmutabilidad, rollback atómico y reentrega.
- Duplicados no producen efectos dobles.
- Payloads no filtran secretos ni datos antiabuso.

### Criterio de éxito

Cada mutación crítica queda trazada y la aplicación sigue consultando estado materializado.

### Resultado verificado

- Event envelope y secuencia estricta por agregado.
- Estado + evento + Outbox en una transacción.
- Event Log protegido contra `UPDATE` y `DELETE`.
- Payload limitado y filtrado contra secretos e identificadores directos.
- Outbox con leases, recuperación, publicación y reintento.
- Consumidores idempotentes con recibo transaccional.
- Proyección mínima para probar reentrega sin efectos dobles.
- 20 tests pasan; typecheck y build pasan.
- Sin endpoints, workers operativos ni funciones de Fase 3.

### Gate

Orden explícita requerida: **“Fase 2 aprobada. Integra la PR y comienza con la Fase 3.”**

## Fase 3 — Propuestas

**Estado: COMPLETADA LOCALMENTE EL 2026-07-24; pendiente de checkpoint humano.**

### Objetivo

Permitir crear, consultar, modificar, archivar y solicitar eliminación con permisos.

### Cambios propuestos

- API y UI mínima de Proposal.
- Máquina de estados y control de concurrencia.
- Moderación y registro histórico.

### Tests críticos

- Crear, consultar, modificar, archivar y eliminar según reglas.
- Actor no autorizado, transición inválida, carrera y validación de tamaños.
- Crear propuesta **no** crea autorización ni ResearchJob.

### Criterio de éxito

Flujo de propuestas seguro, auditable e independiente de Notion.

### Resultado verificado

- Servicio transaccional para crear, consultar, listar, modificar, abrir, archivar y borrar.
- API Fastify con identidad verificada mediante adaptador inyectable.
- Permisos de autor y moderación sin confiar en IDs del cliente.
- Concurrencia optimista coordinada con secuencia de eventos.
- Borrado lógico con redacción y protección del historial de investigación.
- Eventos minimizados sin copiar contenido aportado.
- 28 tests pasan; typecheck y build pasan.
- Crear Proposal no crea Authorization ni ResearchJob.
- UI editable diferida hasta identidad real para no introducir autenticación simulada.

### Gate

Orden explícita requerida: **“Fase 3 aprobada. Integra la PR y comienza con la Fase 4.”**

## Fase 4 — Participación y apoyos

**Estado: CORRECCIONES DE AUDITORÍA IMPLEMENTADAS EL 2026-07-24; pendiente de reauditoría y checkpoint humano.**

### Objetivo

Añadir apoyo evolucionable y resistente a duplicación/abuso.

### Cambios propuestos

- Support con restricción anti-duplicado y revocación.
- Rate limits, cuotas, honeypot/CAPTCHA adaptativo y señales minimizadas.
- Contador materializado y eventos.

### Tests críticos

- Apoyo válido, duplicado, revocación, concurrencia, límites y automatización.
- IP compartida y cambio de IP no equivalen a identidad.
- Apoyar **no** ejecuta IA.

### Criterio de éxito

Contadores consistentes y fraude limitado sin recopilar identidad innecesaria.

### Resultado verificado

- Añadir y revocar apoyos con historial y contador materializado.
- Identidad estable resuelta por servidor y pseudonimizada con HMAC.
- Duplicados protegidos por índice parcial y transacción.
- Reintentos acotados ante concurrencia optimista.
- Límites versionables por sujeto, señal de red y globales.
- Señales de abuso minimizadas con expiración.
- Honeypot neutro; CAPTCHA adaptable desde el resolver de identidad.
- 46 tests pasan; typecheck y build pasan.
- Apoyar o revocar no crea Authorization ni ResearchJob.

### Gate

Orden explícita requerida: **“Fase 4 aprobada. Integra la PR y comienza con la Fase 5.”**

## Fase 5 — Fuentes, afirmaciones y evidencias

**Estado: IMPLEMENTADA LOCALMENTE EL 2026-07-24; pendiente de auditoría y checkpoint humano.**

### Objetivo

Capturar Source, Claim y Evidence como conceptos separados.

### Cambios propuestos

- URLs/documentos y canonicalización.
- Claims atómicas y relaciones de evidencia/contraevidencia.
- Pipeline aislado de metadatos, sin investigación IA.
- Moderación, límites y deduplicación.

### Tests críticos

- URL válida/inválida, protocolos, host interno, redirecciones, duplicados.
- Contenido malicioso, tamaño/MIME y texto con payload XSS.
- Añadir fuente/evidencia **no** ejecuta IA.

### Criterio de éxito

Relaciones trazables, entrada renderizada de forma segura y fetcher resistente a SSRF.

### Resultado verificado

- Source, Claim y Evidence separados y relacionados.
- URL HTTP/HTTPS canónica y deduplicada por Proposal.
- Fetcher aislado con revalidación DNS por salto y límites de MIME, bytes y timeout.
- API autenticada sin confiar en identidad del body.
- Eventos minimizados y Outbox atómico.
- 71 tests pasan; typecheck y build pasan.
- Ninguna contribución crea Authorization, ResearchJob ni ejecuta IA.

### Gate

Orden explícita requerida: **“Fase 5 aprobada. Integra la PR y comienza con la Fase 6.”**

## Fase 6 — Score y elegibilidad

### Objetivo

Calcular dimensiones explicables y determinar elegibilidad sin autorizar ejecución.

### Cambios propuestos

- Políticas versionadas para Priority, Progress y Confidence.
- Support Count como dato independiente.
- Recalculo idempotente y explicación de entradas.
- `threshold_reached` y `proposal_became_eligible`.

### Tests críticos

- Fórmulas, límites, versión, datos faltantes y manipulación.
- Score alto y umbral alcanzado **no** crean ResearchJob ni llaman IA.

### Criterio de éxito

Cada valor puede explicarse y reproducirse; elegibilidad no equivale a autorización.

## Fase 7 — Administración y validación

### Objetivo

Proteger moderación, configuración y revisión humana.

### Cambios propuestos

- IdP, MFA, roles y sesiones administrativas.
- Panel de moderación y cola de elegibles.
- Auditoría, reautenticación y alertas.
- Workflow inicial de validación de resultados (sin IA).

### Tests críticos

- Autenticación, autorización por rol, CSRF, sesión y escalada de privilegios.
- Separación entre moderar, autorizar y validar.

### Criterio de éxito

Acciones críticas requieren identidad fuerte, permiso explícito y quedan auditadas.

## Fase 8 — Autorizaciones y Research Jobs

### Objetivo

Crear trabajos solo desde autorizaciones válidas; todavía puede usarse un ejecutor simulado.

### Cambios propuestos

- Políticas ADMIN, THRESHOLD y, solo si se aprueba aparte, PAYMENT.
- Vigencia, revocación, consumo único y presupuesto.
- Cola, leases, cancelación, pausa, reintentos acotados e idempotencia.
- Ejecutor determinista sin proveedor IA para verificar orquestación.

### Tests críticos

```text
crear propuesta       -> no job
apoyar                -> no job
añadir fuente         -> no job
score alto            -> no job
alcanzar umbral       -> no job automático
autorización inválida -> no job
autorización válida   -> exactamente un job
```

Además: expiración, revocación, doble envío, carreras, cancelación y presupuesto.

### Criterio de éxito

El guard de autorización es demostrable y ningún camino alternativo crea ejecución.

## Fase 9 — Research Engine

### Objetivo

Ejecutar investigación limitada, trazable y estructurada.

### Precondición

Autorización específica para integrar proveedores y, si aplica, incurrir en costes.

### Cambios propuestos

- Orquestador por pasos y gateway neutral de proveedores.
- Búsqueda/fetch controlados, extracción, contraste y síntesis.
- Presupuestos atómicos, deadlines, cancelación y circuit breaker.
- Defensa ante prompt injection y contenido hostil.
- Resultados separados en FACT, CLAIM, INFERENCE, UNCERTAINTY y CONFLICTING EVIDENCE.
- Citas verificables y revisión humana.

### Tests críticos

- Límite de coste, tokens, tiempo, llamadas, tamaño y profundidad.
- Bucle, timeout, proveedor caído, cita inexistente y fuente contradictoria.
- Cancelación, reintento idempotente y recuperación.
- Prompt injection en páginas/documentos.

### Criterio de éxito

Un trabajo autorizado termina o se detiene dentro de límites, produce trazabilidad completa y
no se publica automáticamente.

## Fase 10 — Integración con Knowledge Hub

### Objetivo

Publicar conocimiento validado sin acoplar ni poner en riesgo producción.

### Precondición

Autorización explícita para modificar/integrar el repositorio público.

### Cambios propuestos

- Contrato JSON versionado y compatibilidad.
- Exportación desde resultados `VALIDATED`.
- Revisión por PR como primera opción.
- Sanitización/CSP y endurecimiento del renderizado del Hub.
- Rollback y observabilidad.

### Tests críticos

- Contract tests, compatibilidad, XSS, datos incompletos y duplicados.
- Publicación solo de resultados validados.
- Fallo de integración no altera Research Engine ni datos de origen.

### Criterio de éxito

Publicación revisable y reversible sin credenciales de escritura en frontend.

## Trabajo transversal

En cada fase:

1. threat model actualizado;
2. tests unitarios, integración y negativos proporcionales al riesgo;
3. análisis de dependencias y secretos;
4. observabilidad y runbook;
5. documentación y `DECISION_LOG.md`;
6. demostración del criterio de éxito;
7. checkpoint humano.

## Decisiones necesarias antes de Fase 1

1. Crear o indicar el remoto privado del Research Engine.
2. Elegir stack y alojamiento (recomendación inicial: monolito modular, API tipada y
   PostgreSQL administrado).
3. Definir identidad inicial de participantes.
4. Definir quién puede autorizar y validar.
5. Confirmar si pagos quedan fuera del MVP.
6. Fijar jurisdicción, privacidad y retenciones.
