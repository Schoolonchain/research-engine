import type { BlockchainConnector } from "./connector.js";
import type { DataSourceType, RawBlock, RawTransaction } from "./model.js";
import { BlockchainConnectionError, BlockchainNotFoundError, assertSafeEndpoint } from "./errors.js";

interface TronscanConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly sourceName?: string;
}

interface TronscanBlockResponse {
  readonly number?: number;
  readonly hash?: string;
  readonly parentHash?: string;
  readonly timestamp?: number;
  readonly witnessAddress?: string;
  readonly nrOfTrx?: number;
  readonly size?: number;
}

interface TronscanTransactionCost {
  readonly fee?: number;
  readonly energy_usage_total?: number;
  readonly net_usage?: number;
}

interface TronscanContractData {
  readonly amount?: number;
  readonly owner_address?: string;
  readonly to_address?: string;
}

interface TronscanTransaction {
  readonly hash?: string;
  readonly contractType?: number;
  readonly ownerAddress?: string;
  readonly toAddress?: string;
  readonly amount?: number;
  readonly result?: string;
  readonly cost?: TronscanTransactionCost;
  readonly contractData?: TronscanContractData;
}

interface TronscanTransactionList {
  readonly total?: number;
  readonly data?: readonly TronscanTransaction[];
}

function assertBlockResponse(data: unknown, blockNumber: number): asserts data is TronscanBlockResponse {
  if (!data || typeof data !== "object") {
    throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: not an object`);
  }
  const obj = data as Record<string, unknown>;
  if (obj["number"] !== undefined && typeof obj["number"] !== "number") {
    throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: block number is not a number`);
  }
  if (obj["hash"] !== undefined && typeof obj["hash"] !== "string") {
    throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: hash is not a string`);
  }
  if (obj["timestamp"] !== undefined && typeof obj["timestamp"] !== "number") {
    throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: timestamp is not a number`);
  }
}

function assertTransactionList(data: unknown, blockNumber: number): asserts data is TronscanTransactionList {
  if (!data || typeof data !== "object") {
    throw new BlockchainConnectionError(`Invalid transaction response for block ${blockNumber}: not an object`);
  }
  const obj = data as Record<string, unknown>;
  if (obj["data"] !== undefined && !Array.isArray(obj["data"])) {
    throw new BlockchainConnectionError(`Invalid transaction response for block ${blockNumber}: data is not an array`);
  }
}

const CONTRACT_TYPES: Readonly<Record<number, string>> = {
  1: "TransferContract",
  2: "TransferAssetContract",
  4: "VoteWitnessContract",
  11: "FreezeBalanceContract",
  12: "UnfreezeBalanceContract",
  31: "TriggerSmartContract",
  54: "FreezeBalanceV2Contract",
  55: "UnfreezeBalanceV2Contract",
  56: "WithdrawExpireUnfreezeContract",
  58: "DelegateResourceContract",
  59: "UnDelegateResourceContract",
};

function contractTypeName(type: number | undefined): string {
  if (type === undefined) return "Unknown";
  return CONTRACT_TYPES[type] ?? `ContractType_${type}`;
}

function extractTransactions(
  data: readonly TronscanTransaction[] | undefined,
): RawTransaction[] {
  if (!data) return [];
  return data
    .filter((tx) => tx.hash)
    .map((tx): RawTransaction => {
      const amount = tx.contractData?.amount ?? tx.amount;
      return {
        txHash: tx.hash!,
        txType: contractTypeName(tx.contractType),
        fromAddress: tx.ownerAddress ?? null,
        toAddress: tx.toAddress ?? null,
        amount: amount !== undefined ? String(amount) : null,
        fee: tx.cost?.fee !== undefined ? String(tx.cost.fee) : null,
        amountUnit: "SUN",
        feeUnit: "SUN",
        result: tx.result ?? null,
        chainData: {
          energyUsed: tx.cost?.energy_usage_total ?? null,
          bandwidthUsed: tx.cost?.net_usage ?? null,
        },
        raw: tx as unknown as Readonly<Record<string, unknown>>,
      };
    });
}

export class TronScanConnector implements BlockchainConnector {
  public readonly networkName = "TRON Mainnet";
  public readonly chainId = "tron-mainnet";
  public readonly sourceName: string;
  public readonly sourceType: DataSourceType = "EXPLORER";
  public readonly sourceEndpoint: string;

  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  public constructor(config: TronscanConfig) {
    assertSafeEndpoint(config.endpoint);
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sourceName = config.sourceName ?? "TronScan";
    this.sourceEndpoint = this.endpoint;
  }

  public async getLatestBlockNumber(): Promise<number> {
    const response = await this.get("/api/block", { sort: "-number", limit: "1", start: "0" });
    if (!response || typeof response !== "object") {
      throw new BlockchainConnectionError("Invalid response: not an object");
    }
    const list = response as { data?: unknown };
    if (!Array.isArray(list.data)) {
      throw new BlockchainConnectionError("Invalid response: data is not an array");
    }
    const first = list.data[0] as Record<string, unknown> | undefined;
    if (!first || typeof first["number"] !== "number") {
      throw new BlockchainConnectionError("Invalid response: missing block number");
    }
    return first["number"];
  }

  public async getBlock(blockNumber: number): Promise<RawBlock> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new BlockchainNotFoundError(`Invalid block number: ${blockNumber}`);
    }

    const [blockResponse, txResponse] = await Promise.all([
      this.get("/api/block/info", { num: String(blockNumber) }),
      this.get("/api/transaction", {
        block: String(blockNumber),
        limit: "200",
        start: "0",
        sort: "timestamp",
      }),
    ]);

    assertBlockResponse(blockResponse, blockNumber);
    if (!blockResponse.hash) {
      throw new BlockchainNotFoundError(`Block ${blockNumber} not found`);
    }

    assertTransactionList(txResponse, blockNumber);
    const transactions = extractTransactions(txResponse.data);

    return {
      blockNumber: blockResponse.number ?? blockNumber,
      blockHash: blockResponse.hash,
      parentHash: blockResponse.parentHash ?? "",
      timestamp: blockResponse.timestamp ?? 0,
      blockProducer: blockResponse.witnessAddress ?? null,
      txCount: transactions.length,
      sizeBytes: blockResponse.size ?? null,
      transactions,
      raw: blockResponse as unknown as Readonly<Record<string, unknown>>,
    };
  }

  private async get(
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${this.endpoint}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["TRON-PRO-API-KEY"] = this.apiKey;
    }

    const requestUrl = url.toString();

    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new BlockchainConnectionError(
          `Request to ${path} timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new BlockchainConnectionError(
        `Failed to connect to ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new BlockchainConnectionError(
        `TronScan API error: ${response.status} ${response.statusText} on ${path}`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new BlockchainConnectionError(`Invalid JSON response from ${path}`);
    }
  }
}
