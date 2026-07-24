# Participación y apoyos — Fase 4

## Principios

- Un apoyo representa un sujeto de participación estable, no una dirección IP.
- Una red puede contener muchas personas y una persona puede cambiar de red.
- La identidad y las señales antiabuso permanecen separadas.
- Apoyar o revocar nunca crea Authorization, ResearchJob ni ejecución de IA.
- Todo cambio de contador queda coordinado con Event Log y Outbox.

## Resolución de identidad

La API recibe `ParticipationIdentity` desde un resolver confiable e inyectado:

```ts
interface ParticipationIdentity {
  subjectId: string;
  actorId?: string;
  networkSignal?: string;
}
```

- `subjectId` es estable y opaco.
- `actorId` enlaza opcionalmente una cuenta autenticada.
- `networkSignal` es opcional y solo complementa el análisis.
- Ninguno se acepta desde body, query ni cabeceras arbitrarias dentro del módulo.

El resolver futuro puede exigir CAPTCHA adaptativo antes de devolver una identidad. Fase 4 no
elige proveedor de CAPTCHA ni conserva su token.

## Pseudonimización

Antes de persistir, las señales se derivan con HMAC-SHA-256 y una clave de servidor:

```text
HMAC(secret, "participation:v1:subject:" + stableSubject)
HMAC(secret, "participation:v1:network:" + networkSignal)
```

El keyring:

- contiene objetos `{id, key}` ordenados de nueva primaria a claves anteriores;
- exige al menos 32 caracteres por clave e IDs únicos;
- se carga mediante `PARTICIPATION_HMAC_KEYS`;
- no se versiona y debe almacenarse en un gestor de secretos.

Los hashes se separan por dominio para impedir correlaciones accidentales.

### Rotación

1. Añadir una clave nueva al principio del keyring.
2. Mantener todas las claves anteriores como lookup-only.
3. Desplegar el mismo keyring en todas las instancias.
4. Escribir nuevos apoyos con la primaria y su `subject_key_id`.
5. Detectar duplicados y revocaciones con todas las claves activas.
6. Migrar perezosamente un apoyo antiguo cuando vuelve a interactuar.

La clave más antigua permanece como clave estable de locking/rate limiting durante el rolling
deploy. Así, instancias antiguas y nuevas serializan al mismo sujeto. Una clave no puede
retirarse mientras existan apoyos con su `subject_key_id`; esa condición es consultable. Si
una clave se compromete, la retirada exige revocar o reidentificar esas filas mediante un
procedimiento extraordinario.

## Añadir apoyo

Precondiciones:

- identidad resuelta;
- Proposal en `OPEN` o `COLLECTING`;
- límites no excedidos;
- no existe apoyo activo del mismo sujeto.

Transacción:

1. insertar Support activo;
2. incrementar `support_count` y versión de Proposal;
3. anexar `support_added`;
4. crear mensaje Outbox.

La unicidad parcial `(proposal_id, subject_key_hash) WHERE status = ACTIVE` protege contra
carreras. Un cambio concurrente del agregado se reintenta hasta tres veces.

## Revocar apoyo

El mismo sujeto puede revocar su apoyo activo:

1. Support pasa a `REVOKED`;
2. contador disminuye sin quedar negativo;
3. versión de Proposal avanza;
4. se anexa `support_revoked` y Outbox.

El historial no se sobrescribe. Tras revocar puede crearse un nuevo apoyo.

## Límites antiabuso

Ventanas duraderas e independientes:

- **SUBJECT:** automatización de un sujeto entre muchas propuestas;
- **NETWORK:** señal agregada, con límite más amplio;
- **GLOBAL:** protección de capacidad del sistema.

Política inicial:

| Scope | Intentos/minuto |
|---|---:|
| Subject | 20 |
| Network | 120 |
| Global | 2.000 |

La política es inyectable y versionable. `policy_version` forma parte de la clave primaria del
contador; un cambio de política abre un contador distinto incluso dentro de la misma ventana.
Cada fila guarda el límite aplicado y una fecha de expiración. Al superar un límite:

- la operación se rechaza con `429` y `Retry-After`;
- se registra una señal `RATE_LIMIT_EXCEEDED`;
- la señal contiene solo hash, scope, riesgo, versión y expiración;
- el intento bloqueado no crea Support, evento ni ResearchJob.

La expiración define retención; el proceso periódico de purga pertenecerá a la infraestructura
operativa, todavía inexistente.

## Honeypot

El campo reservado `website` no debe ser rellenado por clientes humanos. Si contiene valor,
la API responde de forma neutra con `202` y no ejecuta participación. No se expone al cliente
que se activó la detección.

## API

| Método | Ruta | Función |
|---|---|---|
| `POST` | `/proposals/:publicId/supports` | Añadir apoyo |
| `DELETE` | `/proposals/:publicId/supports/me` | Revocar apoyo |

Respuestas principales:

- `201`: apoyo añadido;
- `202`: solicitud absorbida por honeypot;
- `401`: falta identidad de participación;
- `404`: no existe apoyo activo al revocar;
- `409`: duplicado o estado incompatible;
- `429`: límite excedido.
- `503`: contención temporal tras agotar reintentos; incluye `Retry-After`.

## Garantías verificadas

- apoyo, contador, evento y Outbox atómicos;
- duplicado rechazado aunque cambie la red;
- sujetos distintos pueden compartir red;
- revocación y nuevo apoyo preservan historial;
- límites y señales persisten tras rechazo;
- no se guarda sujeto ni señal de red en claro;
- body no puede suplantar identidad;
- honeypot no crea apoyo;
- ningún camino crea ResearchJob.
- rotación conserva deduplicación y revocación;
- cambios de política preservan contadores y límites auditables;
- contención usa backoff y termina en una respuesta reintentable.

## Fuera de alcance

- score y umbral: Fase 6;
- autenticación administrativa: Fase 7;
- autorización/ResearchJob: Fase 8;
- CAPTCHA concreto y servicio de anomalías: decisión de despliegue;
- IA: Fase 9.
