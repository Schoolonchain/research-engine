# Auditoría — Integración de datos blockchain (TRON)

Fecha: 2026-07-27
Estado: AUDITORÍA COMPLETADA; PENDIENTE DE APROBACIÓN HUMANA

## 1. Estado actual del proyecto

Research Engine se encuentra en **Fase 6** (Score y elegibilidad), implementada localmente y
pendiente de auditoría y checkpoint humano. El repositorio contiene:

- **25 tablas** en PostgreSQL con 13 migraciones verificadas.
- **7 archivos de tests** con 80+ tests sobre PGlite.
- **6 módulos funcionales**: config, db, domain, events, proposals, participation, knowledge, scoring.
- **Stack fijado**: TypeScript estricto, Node.js 24, Fastify, PostgreSQL, Vitest.
- **Dependencias mínimas**: fastify, pg (producción); pglite, tsx, typescript, vitest (desarrollo).
- **Sin entrypoint desplegable**, sin worker operativo, sin autenticación de producción, sin IA.

Las Fases 7–10 están planificadas pero no implementadas:

| Fase | Contenido | Estado |
|---|---|---|
| 7 | Administración y validación | Planificada |
| 8 | Autorizaciones y Research Jobs | Planificada |
| 9 | Research Engine (ejecución IA) | Planificada |
| 10 | Integración con Knowledge Hub | Planificada |

## 2. Arquitectura relevante para la integración

### Modelo de dominio actual

```text
Actor
  └── Proposal
        ├── Source (URL, DOCUMENT, CONTEXT)
        │     └── Evidence ←── Claim
        ├── Claim
        ├── Support
        └── Score → ScorePolicy
```

### Patrones establecidos

- **Estado materializado + Event Log + Outbox** en una transacción (D-003).
- **Módulos con límites claros** dentro de un monolito modular (D-004).
- **Concurrencia optimista** por version integer en cada agregado.
- **Identidad inyectada** mediante adaptadores; nunca desde el body del cliente.
- **Rate limiting** persistente y multidimensional.
- **Migraciones SQL explícitas** con checksum, sin ORM (D-014).
- **Inmutabilidad** del Event Log protegida por triggers de PostgreSQL.
- **Payload minimizado** en eventos (máx. 64 KiB, sin secretos ni PII).

### Dónde NO encaja la blockchain en el modelo actual

La blockchain no es una Source en el sentido actual del dominio. Las diferencias clave:

| Aspecto | Source actual | Datos blockchain |
|---|---|---|
| Origen | Contribución de un participante | Obtención activa por el sistema |
| Naturaleza | Referencia pasiva (URL/documento) | Datos estructurados, verificables |
| Vinculación | Siempre ligada a una Proposal | Existe independientemente de Proposals |
| Mutabilidad | Fija tras creación | Inmutable por diseño (blockchain) |
| Volumen | Unitaria | Bloques, transacciones, cuentas en masa |

Por tanto, tratar datos blockchain como un tipo más de Source sería una distorsión del modelo
existente. Se necesita un módulo propio.

## 3. Componentes existentes reutilizables

| Componente | Ubicación | Reutilizable para blockchain |
|---|---|---|
| `TransactionalDatabase` | `src/db/database.ts` | Sí — misma interfaz transaccional |
| `EventStore` | `src/events/event-store.ts` | Sí — registro de eventos de recolección |
| `assertSafeEventPayload` | `src/events/payload-policy.ts` | Sí — misma política de payload |
| `PGlite` test pattern | `tests/migrations.test.ts` | Sí — misma base de tests |
| `loadEnvironment` | `src/config/environment.ts` | Extensible para nuevas variables |
| Migration runner | `src/db/migrations.ts` | Sí — misma infraestructura |
| Outbox | `src/events/outbox.ts` | Sí — entrega de eventos futura |
| Domain model types | `src/domain/model.ts` | Extensible con tipos blockchain |

## 4. Componentes nuevos necesarios

| Componente | Propósito | Prioridad |
|---|---|---|
| `blockchain/connector.ts` | Interfaz abstracta de conexión a blockchain | MVP |
| `blockchain/tron-connector.ts` | Implementación de conector para TRON vía TronGrid | MVP |
| `blockchain/model.ts` | Tipos para bloques, transacciones, cuentas, redes | MVP |
| `blockchain/blockchain-service.ts` | Servicio de recolección, normalización y persistencia | MVP |
| `blockchain/errors.ts` | Errores tipados del módulo | MVP |
| Migration `0014_blockchain_data.sql` | Tablas para datos blockchain | MVP |
| `tests/blockchain.test.ts` | Tests del módulo | MVP |

## 5. Decisiones arquitectónicas afectadas

### No afectadas

- D-001 (separación Research Engine / Knowledge Hub): se mantiene intacta.
- D-002 (Knowledge Hub es producción): no se toca.
- D-003 (estado + event log + outbox): se reutiliza sin modificar.
- D-004 (módulos con límites): se añade un nuevo módulo, no se fusionan los existentes.
- D-005 (Source, Claim, Evidence separados): no se alteran.

### Potencialmente afectadas

- **D-011 (stack)**: se mantiene TypeScript + PostgreSQL, pero se añade dependencia de HTTP
  client para llamadas a APIs externas.
- **D-014 (migraciones)**: se añade una nueva migración, consistente con el patrón.
- **Fase 9 (Research Orchestrator)**: los datos blockchain podrían ser una fuente de datos para
  el orquestador futuro. La interfaz de conector debe ser compatible.

### Decisiones nuevas propuestas

- **D-059**: Los datos blockchain se almacenan en tablas propias, no en `sources`.
- **D-060**: El conector blockchain es una interfaz inyectable; la implementación TronGrid es
  la primera, pero puede sustituirse por conexión directa a nodo.
- **D-061**: La recolección de datos blockchain no crea Authorization ni ResearchJob.
- **D-062**: Cada dato almacenado conserva su procedencia completa (red, API, bloque, timestamp).

## 6. Datos iniciales del especialista de TRON

Para validar el flujo completo, el MVP debe obtener:

1. **Información de bloque**: número, hash, timestamp, witness, tamaño, conteo de transacciones.
2. **Transacciones del bloque**: ID, tipo, emisor, receptor, cantidad, resultado, consumo de recursos.

Estos dos elementos son suficientes para demostrar:
- Conexión real con la red TRON.
- Obtención de datos estructurados.
- Normalización hacia un esquema relacional.
- Persistencia con procedencia.
- Consulta de datos almacenados.

Los siguientes componentes quedan para iteraciones posteriores:

| Dato | Iteración |
|---|---|
| Cuentas y balances | Segunda |
| Contratos inteligentes | Segunda |
| Tokens TRC-10/TRC-20 | Segunda |
| Energy y Bandwidth | Segunda |
| Staking / TRX Power | Tercera |
| Super Representatives | Tercera |
| Actividad agregada de red | Tercera |

## 7. Fuentes de datos

### TronGrid API (api.trongrid.io)

- API oficial mantenida por TRON Foundation.
- Endpoints HTTP POST con respuestas JSON.
- Ofrece Full Node API, Solidity API y Event API.
- Tier gratuito disponible (requiere API key para producción).
- Endpoints relevantes para MVP:
  - `wallet/getblock` — obtener bloque por número.
  - `wallet/getnowblock` — obtener bloque más reciente.
  - `wallet/gettransactioninfobyblocknum` — transacciones de un bloque.

### TRONSCAN API (apilist.tronscanapi.com)

- API del explorador de bloques más utilizado de TRON.
- Datos agregados y enriquecidos.
- Útil para: información de cuentas, tokens, contratos, estadísticas de red.
- Limitada por rate limiting más estricto.
- Mejor para datos ya procesados, no para datos brutos de blockchain.

### Conexión directa a nodo

- Requiere acceso a un full node TRON (propio o de terceros).
- Máxima autonomía y verificabilidad.
- Complejidad significativamente mayor.
- Adecuada para producción, no para MVP.

## 8. Qué obtener directamente de la blockchain

Datos que deben provenir de la blockchain (via TronGrid como proxy del nodo):

- Bloques: número, hash, timestamp, witness address, tamaño.
- Transacciones: ID, tipo, datos del contrato, resultado, firma.
- Estos datos son verificables criptográficamente y no dependen de interpretación de terceros.

## 9. Qué obtener mediante APIs como TRONSCAN

Datos que TRONSCAN agrega y no están directamente en un bloque individual:

- Información enriquecida de cuentas (nombre, tipo, historial).
- Metadatos de tokens (nombre, símbolo, supply, holders).
- Estadísticas de red (TPS, volumen, actividad).
- Información de Super Representatives (votos, recompensas).

Para el MVP, no se necesita TRONSCAN. TronGrid es suficiente.

## 10. Almacenamiento

### Tablas nuevas (migración `0014_blockchain_data.sql`)

```text
blockchain_networks
  ├── id, name, chain_id, rpc_endpoint, status
  └── Registro de redes soportadas (TRON mainnet inicialmente)

blockchain_blocks
  ├── id, network_id, block_number, block_hash, parent_hash
  ├── timestamp, witness_address, tx_count, size_bytes
  ├── raw_data (JSONB), collected_at, collection_source
  └── Datos normalizados de bloques con procedencia

blockchain_transactions
  ├── id, network_id, block_id, tx_hash
  ├── tx_type, from_address, to_address, amount_sun
  ├── result, fee_sun, energy_used, bandwidth_used
  ├── raw_data (JSONB), collected_at
  └── Datos normalizados de transacciones

data_collection_runs
  ├── id, network_id, run_type, started_at, completed_at
  ├── status, blocks_collected, txs_collected
  ├── source_api, error_detail
  └── Registro de cada ejecución de recolección
```

### Justificación frente a la arquitectura existente

- Se reutiliza PostgreSQL y el runner de migraciones existente.
- No se introduce un sistema de almacenamiento nuevo.
- Las tablas no invaden el espacio de `sources`, `claims` ni `evidence`.
- El `raw_data` JSONB conserva los datos originales para auditabilidad.
- `collection_source` documenta qué API proporcionó cada dato.

## Frontera Research Engine — Knowledge Hub

```text
TRON / Blockchain
        ↓
     RESEARCH ENGINE
        ↓
  Datos brutos (bloques, transacciones)
  Datos normalizados (esquema relacional)
  Observaciones (patrones detectados)
  Evidencias (datos verificables on-chain)
  Investigaciones (análisis futuro)
        ↓
     KNOWLEDGE HUB
        ↓
  Conocimiento consolidado
  Entidades (cuentas, contratos, tokens)
  Relaciones (flujos entre entidades)
  Hipótesis (patrones sospechosos)
  Teorías (conclusiones validadas)
```

### Qué permanece en Research Engine

- Datos brutos de bloques y transacciones.
- Metadatos de procedencia (cuándo, de dónde, cómo).
- Registros de recolección.
- Datos normalizados pero no interpretados.
- Futuro: observaciones derivadas, claims con evidencia on-chain.

### Qué se convierte en conocimiento (Knowledge Hub, futuro)

- Entidades verificadas (cuentas con identidad, contratos clasificados).
- Relaciones entre entidades (flujos de fondos, interacciones de contratos).
- Patrones confirmados y validados por revisión humana.
- Solo mediante el mecanismo de Fase 10 (artefacto JSON + PR revisable).

## MVP: Vertical Slice

```text
TRON Mainnet (TronGrid API)
     ↓
TronConnector (HTTP → JSON)
     ↓
BlockchainService.collectBlock(blockNumber)
     ↓
Normalización (raw → schema relacional)
     ↓
PostgreSQL (blockchain_blocks + blockchain_transactions)
     ↓
Event Log (blockchain_block_collected)
     ↓
BlockchainService.getBlock(blockNumber) → consulta
```

Este slice demuestra que Research Engine puede:
1. Conectarse a una blockchain real.
2. Obtener datos verificables.
3. Normalizarlos y almacenarlos con procedencia.
4. Registrar la operación en el Event Log.
5. Consultar los datos almacenados.

Sin crear Authorization, ResearchJob ni ejecutar IA.
