import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { BlockchainBlock, BlockchainDataSource, BlockchainTransaction } from "./model.js";
import type { BlockchainService, CollectBlockResult } from "./blockchain-service.js";
import {
  BlockchainConflictError,
  BlockchainConnectionError,
  BlockchainNotFoundError,
  BlockchainValidationError,
} from "./errors.js";

export interface BlockchainApiDependencies {
  readonly blockchain: BlockchainService;
}

function serializeBlock(block: BlockchainBlock): Record<string, unknown> {
  return {
    id: block.id,
    networkId: block.networkId,
    dataSourceId: block.dataSourceId,
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    parentHash: block.parentHash,
    blockTimestamp: block.blockTimestamp,
    blockProducer: block.blockProducer,
    txCount: block.txCount,
    sizeBytes: block.sizeBytes,
    collectionSource: block.collectionSource,
    collectedAt: block.collectedAt,
  };
}

function serializeTransaction(tx: BlockchainTransaction): Record<string, unknown> {
  return {
    id: tx.id,
    networkId: tx.networkId,
    dataSourceId: tx.dataSourceId,
    blockId: tx.blockId,
    txHash: tx.txHash,
    txType: tx.txType,
    fromAddress: tx.fromAddress,
    toAddress: tx.toAddress,
    amount: tx.amount,
    fee: tx.fee,
    amountUnit: tx.amountUnit,
    feeUnit: tx.feeUnit,
    result: tx.result,
    chainData: tx.chainData,
    collectedAt: tx.collectedAt,
  };
}

function serializeDataSource(ds: BlockchainDataSource): Record<string, unknown> {
  return {
    id: ds.id,
    networkId: ds.networkId,
    sourceType: ds.sourceType,
    name: ds.name,
    status: ds.status,
    priority: ds.priority,
  };
}

function serializeCollectResult(result: CollectBlockResult): Record<string, unknown> {
  return {
    block: serializeBlock(result.block),
    transactions: result.transactions.map(serializeTransaction),
    collectionRun: result.collectionRun,
  };
}

export function buildBlockchainApi(
  dependencies: BlockchainApiDependencies,
): FastifyInstance {
  const application = Fastify({
    logger: process.env["NODE_ENV"] !== "test",
    bodyLimit: 10_000,
    requestTimeout: 30_000,
  });

  application.setErrorHandler((error, _request, reply) => {
    if (error instanceof BlockchainValidationError) {
      return reply.status(400).send({ error: "INVALID_REQUEST", message: error.message });
    }
    if (error instanceof BlockchainNotFoundError) {
      return reply.status(404).send({ error: "NOT_FOUND", message: error.message });
    }
    if (error instanceof BlockchainConflictError) {
      return reply.status(409).send({ error: "CONFLICT", message: error.message });
    }
    if (error instanceof BlockchainConnectionError) {
      return reply.status(502).send({ error: "UPSTREAM_ERROR", message: "Upstream service temporarily unavailable" });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR" });
  });

  application.post("/blockchain/collect", async (request, reply) => {
    const body = request.body as { blockNumber?: unknown } | null;
    if (!body || typeof body.blockNumber !== "number") {
      throw new BlockchainValidationError("blockNumber must be a number");
    }
    const result = await dependencies.blockchain.collectBlock(body.blockNumber);
    return reply.status(201).send(serializeCollectResult(result));
  });

  application.get("/blockchain/blocks/:blockNumber", async (request) => {
    const blockNumber = parseBlockNumber(request);
    const network = await dependencies.blockchain.ensureNetwork();
    const block = await dependencies.blockchain.getBlock(network.id, blockNumber);
    if (!block) {
      throw new BlockchainNotFoundError(`Block ${blockNumber} not found`);
    }
    return serializeBlock(block);
  });

  application.get("/blockchain/blocks/:blockNumber/observations", async (request) => {
    const blockNumber = parseBlockNumber(request);
    const network = await dependencies.blockchain.ensureNetwork();
    const observations = await dependencies.blockchain.getBlockObservations(network.id, blockNumber);
    return observations.map(serializeBlock);
  });

  application.get("/blockchain/blocks/:blockNumber/transactions", async (request) => {
    const blockNumber = parseBlockNumber(request);
    const network = await dependencies.blockchain.ensureNetwork();
    const block = await dependencies.blockchain.getBlock(network.id, blockNumber);
    if (!block) {
      throw new BlockchainNotFoundError(`Block ${blockNumber} not found`);
    }
    const txs = await dependencies.blockchain.getTransactionsByBlock(block.id);
    return txs.map(serializeTransaction);
  });

  application.get("/blockchain/latest", async () => {
    const blockNumber = await dependencies.blockchain.getLatestBlockNumber();
    return { blockNumber };
  });

  application.get("/blockchain/network", async () => {
    return dependencies.blockchain.ensureNetwork();
  });

  application.get("/blockchain/sources", async () => {
    const network = await dependencies.blockchain.ensureNetwork();
    const sources = await dependencies.blockchain.getDataSourcesForNetwork(network.id);
    return sources.map(serializeDataSource);
  });

  return application;
}

function parseBlockNumber(request: FastifyRequest): number {
  const params = request.params as { blockNumber?: string };
  const value = Number(params.blockNumber);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BlockchainValidationError("blockNumber must be a non-negative integer");
  }
  return value;
}
