# Respuesta a auditoría — Fase 4

Fecha: 2026-07-24  
Estado: tercera ronda de correcciones implementada; pendiente de nueva auditoría

## H-001 — Rotación HMAC

**Corregido.**

- Keyring ordenado con IDs únicos.
- Escritura con clave primaria.
- Lookup y revocación con todas las claves activas.
- `subject_key_id` persistido en Support.
- Lock transaccional estable durante rolling deploy.
- Migración perezosa al detectar un apoyo creado con clave anterior.
- `assertReady()` y cada operación bloquean la configuración si falta una clave usada por
  apoyos activos.

Prueba automatizada:

1. crear apoyo con `legacy-v1`;
2. añadir `rotation-v2` como primaria;
3. comprobar que el mismo sujeto sigue siendo duplicado;
4. revocar mediante el keyring nuevo;
5. volver a apoyar y comprobar escritura con `rotation-v2`.
6. retirar prematuramente `legacy-v1` y comprobar que la activación/operación se bloquea.

El primer despliegue es deliberadamente de dos etapas: primero se publica soporte de keyring
con la clave vigente; después se introduce una nueva primaria manteniendo la anterior.

### Cierre adicional de ronda 2

- `participation_key_registry` vincula cada ID a un verificador HMAC persistente.
- El mismo ID con otro secreto bloquea `assertReady()` y todas las operaciones.
- Un test reproduce la sustitución A→B bajo `legacy-v1` y confirma que el contador permanece
  en uno.
- `active_support_count` se mantiene por trigger al añadir, revocar o rehashear.
- El guard normal consulta el registro acotado de claves, no escanea apoyos activos.

## M-004 — Ciclo de vida de locks

**Corregido.**

- La Proposal se valida antes de crear el lock.
- Los locks expiran tras 24 horas de inactividad.
- Cada operación purga locks vencidos antes de adquirir el suyo.
- Un test adversarial confirma que una Proposal inexistente no deja locks.

## M-005 — Trazabilidad de rehash

**Corregido.**

La tabla `participation_identity_migrations` registra Support, clave anterior, clave nueva y
timestamp. Se excluye Event Log/Outbox porque el rehash no altera el apoyo ni el contador;
la operación de seguridad conserva una auditoría restringida sin retener el hash anterior.

## M-001 — Versionado de rate limits

**Corregido.**

`policy_version` forma parte de la clave primaria. Dos políticas dentro de una misma ventana
conservan contadores y `limit_snapshot` independientes. La prueba verifica versiones 1/2 con
límites 20/100.

## M-002 — Concurrencia y respuesta HTTP

**Corregido.**

- Prueba con dos apoyos iniciados concurrentemente sobre una Proposal.
- Reintentos con backoff exponencial y jitter.
- Prueba determinista de agotamiento tras tres conflictos.
- Conversión a `503 TEMPORARY_CONTENTION` con `Retry-After: 1`.

## M-003 — Gobierno

**Corregido.**

- P-001 y P-002 marcadas resueltas.
- P-004 marcada parcial: contrato listo, proveedor de identidad pendiente.
- D-026–D-034 quedan pendientes de aprobación humana de Fase 4.

## L-001 — Estado de API

**Corregido.**

README distingue entre constructores Fastify existentes y ausencia de un punto de entrada
desplegable.

## Verificaciones disponibles

- Suite local: pendiente de repetición tras esta tercera ronda correctiva.
- TypeScript estricto.
- Build Node.js 24.
- CI de PR #4 fue verificada previamente como aprobada; deberá ejecutarse nuevamente con el
  commit correctivo.

## Pendientes no bloqueantes registrados

- prueba adicional contra PostgreSQL externo/real;
- purga operativa de rate limits y señales expiradas;
- proveedor real de identidad/CAPTCHA;
- auditoría de dependencias si se autoriza el envío de metadatos al registro.
