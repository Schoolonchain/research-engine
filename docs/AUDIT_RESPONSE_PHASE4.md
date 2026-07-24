# Respuesta a auditoría — Fase 4

Fecha: 2026-07-24  
Estado: correcciones implementadas; pendiente de nueva auditoría

## H-001 — Rotación HMAC

**Corregido.**

- Keyring ordenado con IDs únicos.
- Escritura con clave primaria.
- Lookup y revocación con todas las claves activas.
- `subject_key_id` persistido en Support.
- Lock transaccional estable durante rolling deploy.
- Migración perezosa al detectar un apoyo creado con clave anterior.
- Retiro bloqueado mientras existan filas asociadas a una clave.

Prueba automatizada:

1. crear apoyo con `legacy-v1`;
2. añadir `rotation-v2` como primaria;
3. comprobar que el mismo sujeto sigue siendo duplicado;
4. revocar mediante el keyring nuevo;
5. volver a apoyar y comprobar escritura con `rotation-v2`.

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

- Suite local: 5 archivos, 41 tests.
- TypeScript estricto.
- Build Node.js 24.
- CI de PR #4 fue verificada previamente como aprobada; deberá ejecutarse nuevamente con el
  commit correctivo.

## Pendientes no bloqueantes registrados

- prueba adicional contra PostgreSQL externo/real;
- purga operativa de filas expiradas;
- proveedor real de identidad/CAPTCHA;
- auditoría de dependencias si se autoriza el envío de metadatos al registro.

