import type { BlockchainConnector } from "./connector.js";
import type { RawBlock, RawTransaction } from "./model.js";
import { BlockchainConnectionError, BlockchainNotFoundError } from "./errors.js";

interface TronGridConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
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

function hexToBase58Check(hex: string | undefined): string | null {
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
      fromAddress: hexToBase58Check(value?.owner_address),
      toAddress: hexToBase58Check(value?.to_address),
      amountSun: amount !== undefined ? BigInt(amount) : null,
      result: tx.ret?.[0]?.contractRet ?? null,
      feeSun: info?.fee !== undefined ? BigInt(info.fee) : null,
      energyUsed: info?.receipt?.energy_usage_total !== undefined
        ? BigInt(info.receipt.energy_usage_total)
        : null,
      bandwidthUsed: info?.receipt?.net_usage !== undefined
        ? BigInt(info.receipt.net_usage)
        : null,
      raw: tx as unknown as Readonly<Record<string, unknown>>,
    };
  });
}

export class TronGridConnector implements BlockchainConnector {
  public readonly networkName = "TRON Mainnet";
  public readonly sourceApi: string;

  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  public constructor(config: TronGridConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sourceApi = `trongrid:${this.endpoint}`;
  }

  public async getLatestBlockNumber(): Promise<number> {
    const response = await this.post("/wallet/getnowblock", {});
    const block = response as TronBlockResponse;
    const number = block.block_header?.raw_data?.number;
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

    const block = blockResponse as TronBlockResponse;
    if (!block.blockID) {
      throw new BlockchainNotFoundError(`Block ${blockNumber} not found`);
    }

    const header = block.block_header?.raw_data;
    if (!header) {
      throw new BlockchainConnectionError("Invalid response: missing block header");
    }

    const infos = Array.isArray(infoResponse) ? infoResponse as TronTransactionInfo[] : [];
    const infoMap = new Map<string, TronTransactionInfo>();
    for (const info of infos) {
      if (info.id) infoMap.set(info.id, info);
    }

    const transactions = extractTransactions(block.transactions, infoMap);
    const rawSize = JSON.stringify(block).length;

    return {
      blockNumber: header.number ?? blockNumber,
      blockHash: block.blockID,
      parentHash: header.parentHash ?? "",
      timestamp: header.timestamp ?? 0,
      witnessAddress: hexToBase58Check(header.witness_address),
      txCount: transactions.length,
      sizeBytes: rawSize,
      transactions,
      raw: block as unknown as Readonly<Record<string, unknown>>,
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
