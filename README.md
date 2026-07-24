# Research Engine

Sistema independiente para recopilar propuestas y evidencias, autorizar investigación con
límites verificables y producir resultados revisables para una futura integración con
Knowledge Hub.

## Estado

**Fase 2 — Eventos, auditoría y Outbox.**

Este repositorio todavía no expone endpoints ni ejecuta investigación. La presencia de las
tablas `authorizations` y `research_jobs` no habilita ningún flujo operativo.

## Requisitos

- Node.js 24 o superior
- pnpm 11.9.0
- PostgreSQL compatible para uso real

Los tests de migración usan PGlite y no requieren Docker ni una base externa.

## Preparación local

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm check
pnpm test
pnpm build
```

No uses las credenciales de ejemplo en entornos compartidos. `.env` está excluido de Git.

## Migraciones

Con `DATABASE_URL` configurada:

```bash
pnpm db:migrate
```

El runner:

- aplica archivos `migrations/NNNN_name.sql` en orden;
- ejecuta cada migración en una transacción;
- registra nombre y SHA-256 en `schema_migrations`;
- rechaza la modificación retroactiva de una migración aplicada;
- puede ejecutarse repetidamente sin reaplicar versiones.

Las migraciones aplicadas son inmutables. Los cambios posteriores deben añadirse como una
nueva migración.

## Comandos

| Comando | Función |
|---|---|
| `pnpm check` | Comprobación estricta de TypeScript |
| `pnpm test` | Tests unitarios y de migración PostgreSQL |
| `pnpm build` | Compilación a `dist/` |
| `pnpm db:migrate` | Aplicación de migraciones a `DATABASE_URL` |

## Documentación

- [Arquitectura](ARCHITECTURE.md)
- [Modelo de datos](docs/DATABASE_SCHEMA.md)
- [Eventos y Outbox](docs/EVENTS.md)
- [Plan de implementación](IMPLEMENTATION_PLAN.md)
- [Registro de decisiones](DECISION_LOG.md)

## Límites de seguridad vigentes

- Knowledge Hub público es producción y no se modifica.
- Notion no es dependencia del dominio.
- Umbral o score no equivalen a autorización.
- No existe aún un servicio capaz de crear o ejecutar Research Jobs.
- El Event Log y Outbox no incluyen un worker operativo.
- No se versionan secretos.

