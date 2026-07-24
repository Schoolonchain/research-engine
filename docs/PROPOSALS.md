# Propuestas — Fase 3

## Alcance

Fase 3 implementa el agregado Proposal y su API:

- crear;
- listar y consultar;
- modificar contenido y visibilidad;
- abrir;
- archivar;
- borrar según reglas.

Cada mutación actualiza estado, agrega un evento y crea Outbox en una sola transacción.

## Límite de identidad

La API requiere un `ProposalAuthenticator` inyectado. Este adaptador debe devolver una
identidad ya verificada:

```ts
interface ActorContext {
  actorId: string;
  role: "USER" | "MODERATOR" | "ADMIN";
}
```

La API:

- no acepta identidad del body o query;
- devuelve `401` cuando falta autenticación;
- devuelve `403` cuando la identidad existe pero carece de permiso;
- no incluye un autenticador de producción en Fase 3.

En tests se usa un mapa de tokens aislado. No es código desplegable ni un mecanismo de
autenticación propuesto para producción.

## Permisos

| Acción | Público | Autor | Moderador/Admin |
|---|---:|---:|---:|
| Ver Proposal pública | Sí | Sí | Sí |
| Ver Proposal privada | No | Sí | Sí |
| Crear | No | Sí | Sí |
| Modificar editable | No | Sí | Sí |
| Abrir | No | Sí | Sí |
| Archivar | No | Sí | Sí |
| Borrar CREATED | No | Sí | Sí |
| Borrar después de abrir | No | No | Sí, si no hay historial de investigación |

Una Proposal `DELETED` se comporta como inexistente. El borrado es lógico y redacta título,
pregunta y descripción. El evento conserva que ocurrió el borrado, pero no copia el contenido.

## Estados implementados

```text
CREATED -> OPEN
    |        |
    +--------+--> ARCHIVED

CREATED -> DELETED                      (autor o moderación)
OPEN/otros activos -> DELETED           (solo moderación)
```

El método de archivo acepta los estados activos previstos hasta `ELIGIBLE`; no permite
archivar `AUTHORIZED`, estados terminales ni eliminados.

Estados posteriores continúan presentes en el esquema para las fases que los controlarán,
pero Fase 3 no implementa sus transiciones.

## Concurrencia

Toda mutación exige `expectedVersion`.

- La fila se actualiza solo si coincide la versión.
- La secuencia del Event Log debe coincidir con la misma versión.
- Un escritor obsoleto obtiene `409 CONFLICT`.
- El fallo revierte estado, evento y Outbox.

## API

| Método | Ruta | Resultado |
|---|---|---|
| `POST` | `/proposals` | Crear (`201`) |
| `GET` | `/proposals` | Listar con `limit`/`offset` |
| `GET` | `/proposals/:publicId` | Consultar |
| `PATCH` | `/proposals/:publicId` | Modificar |
| `POST` | `/proposals/:publicId/open` | Abrir |
| `POST` | `/proposals/:publicId/archive` | Archivar |
| `DELETE` | `/proposals/:publicId` | Borrar (`204`) |

El servidor Fastify aplica body máximo de 25 KiB y timeout de 10 segundos. Los campos del
dominio tienen límites adicionales:

- título: 1–240 caracteres;
- pregunta central: 1–2.000;
- descripción: 0–20.000;
- motivo: 1–2.000;
- listado: máximo 100 registros por consulta.

## Eventos

- `proposal_created`
- `proposal_updated`
- `proposal_opened`
- `proposal_archived`
- `proposal_deleted`

Los eventos registran campos modificados, transición y versión, no el texto aportado. Esto
reduce exposición de contenido personal en un historial inmutable.

## Errores HTTP

| Estado | Código |
|---:|---|
| 400 | `INVALID_REQUEST` |
| 401 | `AUTHENTICATION_REQUIRED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 500 | `INTERNAL_ERROR` |

No se filtran detalles internos en respuestas.

## Verificación

La suite comprueba:

- creación, consulta y normalización;
- evento y Outbox atómicos;
- creación no produce ResearchJob;
- propiedad y moderación;
- actualización obsoleta;
- transiciones y orden de eventos;
- visibilidad privada;
- borrado lógico y redacción;
- restricción de borrado después de abrir;
- preservación de historial de investigación;
- identidad tomada del autenticador, no del body;
- límites de consulta y errores HTTP.

## Decisión sobre UI

La UI editable prevista inicialmente se difiere hasta que exista una integración de identidad
real. Una UI que pidiera al cliente un actor ID o token de prueba daría una falsa garantía de
permisos. Esta decisión no bloquea el dominio ni la API; queda localizada en la superficie
interactiva.

