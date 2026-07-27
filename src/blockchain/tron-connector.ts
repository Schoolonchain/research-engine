import type { BlockchainConnector } from "./connector.js";
import type { DataSourceType, RawBlock, RawTransaction } from "./model.js";
import { BlockchainConnectionError, BlockchainNotFoundError, assertSafeEndpoint } from "./errors.js";

interface TronGridConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly sourceName?: string;
}

interface TronBlockHeader {
  readonly number?: number;
  readonly txTrieRoot?: string;
  readonly parentHash?: string;
  readonly timestamp?: number;
  readonly witness_address?: string;
}

interface TronBlockResponse {
  readonly blockID?: string;
  readonly block_header?: {
    readonly raw_data?: TronBlockHeader;
  };
  readonly transactions?: readonly TronRawTransaction[];
}

interface TronContractValue {
  readonly owner_address?: string;
  readonly to_address?: string;
  readonly amount?: number;
}

interface TronContract {
  readonly type?: string;
  readonly parameter?: {
    readonly value?: TronContractValue;
  };
}

interface TronRawTransaction {
  readonly txID?: string;
  readonly raw_data?: {
    readonly contract?: readonly TronContract[];
    readonly ref_block_bytes?: string;
  };
  readonly ret?: readonly { readonly contractRet?: string }[];
}

interface TronTransactionInfo {
  readonly id?: string;
  readonly fee?: number;
  readonly receipt?: {
    readonly energy_usage_total?: number;
    readonly net_usage?: number;
  };
}

function assertBlockResponse(data: unknown, blockNumber: number): asserts data is TronBlockResponse {
  if (!data || typeof data !== "object") {
    throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: not an object`);
  }
  const obj = data as Record<string, unknown>;
  if (obj.blockID !== undefined && typeof obj.blockID !== "string") {
    throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: blockID is not a string`);
  }
  if (obj.block_header !== undefined) {
    if (typeof obj.block_header !== "object" || obj.block_header === null) {
      throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: block_header is not an object`);
    }
    const header = obj.block_header as Record<string, unknown>;
    if (header.raw_data !== undefined) {
      if (typeof header.raw_data !== "object" || header.raw_data === null) {
        throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: raw_data is not an object`);
      }
      const raw = header.raw_data as Record<string, unknown>;
      if (raw.number !== undefined && typeof raw.number !== "number") {
        throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: block number is not a number`);
      }
      if (raw.timestamp !== undefined && typeof raw.timestamp !== "number") {
        throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: timestamp is not a number`);
      }
    }
  }
  if (obj.transactions !== undefined && !Array.isArray(obj.transactions)) {
    throw new BlockchainConnectionError(`Invalid block response for block ${blockNumber}: transactions is not an array`);
  }
}

function assertTransactionInfoArray(data: unknown, blockNumber: number): asserts data is TronTransactionInfo[] {
  if (!Array.isArray(data)) {
    throw new BlockchainConnectionError(`Invalid transaction info response for block ${blockNumber}: not an array`);
  }
}

// TRON addresses arrive as hex; stored as-is until a Base58Check encoder is added.
function normalizeAddress(hex: string | undefined): string | null {
  if (!hex) return null;
  return hex;
}

function extractTransactions(
  tronTxs: readonly TronRawTransaction[] | undefined,
  infoMap: ReadonlyMap<string, TronTransactionInfo>,
): RawTransaction[] {
  if (!tronTxs) return [];
  return tronTxs.map((tx): RawTransaction => {
    const contract = tx.raw_data?.contract?.[0];
    const value = contract?.parameter?.value;
    const info = tx.txID ? infoMap.get(tx.txID) : undefined;
    const amount = value?.amount;
    return {
      txHash: tx.txID ?? "",
      txType: contract?.type ?? "Unknown",
      fromAddress: normalizeAddress(value?.owner_address),
      toAddress: normalizeAddress(value?.to_address),
      amount: amount !== undefined ? String(amount) : null,
      fee: info?.fee !== undefined ? String(info.fee) : null,
      amountUnit: "SUN",
      feeUnit: "SUN",
      result: tx.ret?.[0]?.contractRet ?? null,
      chainData: {
        energyUsed: info?.receipt?.energy_usage_total ?? null,
        bandwidthUsed: info?.receipt?.net_usage ?? null,
      },
      raw: tx as unknown as Readonly<Record<string, unknown>>,
    };
  });
}

export class TronGridConnector implements BlockchainConnector {
  public readonly networkName = "TRON Mainnet";
  public readonly chainId = "tron-mainnet";
  public readonly sourceName: string;
  public readonly sourceType: DataSourceType = "API";
  public readonly sourceEndpoint: string;

  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  public constructor(config: TronGridConfig) {
    assertSafeEndpoint(config.endpoint);
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sourceName = config.sourceName ?? "TronGrid";
    this.sourceEndpoint = this.endpoint;
  }

  public async getLatestBlockNumber(): Promise<number> {
    const response = await this.post("/wallet/getnowblock", {});
    assertBlockResponse(response, -1);
    const number = response.block_header?.raw_data?.number;
    if (number === undefined) {
      throw new BlockchainConnectionError("Invalid response: missing block number");
    }
    return number;
  }

  public async getBlock(blockNumber: number): Promise<RawBlock> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new BlockchainNotFoundError(`Invalid block number: ${blockNumber}`);
    }

    const [blockResponse, infoResponse] = await Promise.all([
      this.post("/wallet/getblockbynum", { num: blockNumber }),
      this.post("/wallet/gettransactioninfobyblocknum", { num: blockNumber }),
    ]);

    assertBlockResponse(blockResponse, blockNumber);
    if (!blockResponse.blockID) {
      throw new BlockchainNotFoundError(`Block ${blockNumber} not found`);
    }

    const header = blockResponse.block_header?.raw_data;
    if (!header) {
      throw new BlockchainConnectionError("Invalid response: missing block header");
    }

    assertTransactionInfoArray(infoResponse, blockNumber);
    const infoMap = new Map<string, TronTransactionInfo>();
    for (const info of infoResponse) {
      if (info.id) infoMap.set(info.id, info);
    }

    const transactions = extractTransactions(blockResponse.transactions, infoMap);
    const rawSize = JSON.stringify(blockResponse).length;

    return {
      blockNumber: header.number ?? blockNumber,
      blockHash: blockResponse.blockID,
      parentHash: header.parentHash ?? "",
      timestamp: header.timestamp ?? 0,
      blockProducer: normalizeAddress(header.witness_address),
      txCount: transactions.length,
      sizeBytes: rawSize,
      transactions,
      raw: blockResponse as unknown as Readonly<Record<string, unknown>>,
    };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.endpoint}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    if (this.apiKey) {
      headers["TRON-PRO-API-KEY"] = this.apiKey;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new BlockchainConnectionError(`Request to ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new BlockchainConnectionError(
        `Failed to connect to ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new BlockchainConnectionError(
        `TronGrid API error: ${response.status} ${response.statusText} on ${path}`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new BlockchainConnectionError(`Invalid JSON response from ${path}`);
    }
  }
}
