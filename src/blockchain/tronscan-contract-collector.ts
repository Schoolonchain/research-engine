import type { TronCollector } from "./tron-collector.js";
import type { TronHttpClient } from "./tron-http-client.js";
import type { DataSourceType } from "./model.js";
import type { ContractTarget, TronContractInfo } from "./audit-model.js";
import { AddressCodec } from "./normalizers.js";
import { BlockchainValidationError } from "./errors.js";

interface TronScanContractResponse {
  readonly data?: readonly TronScanContractItem[];
}

interface TronScanContractItem {
  readonly address?: string;
  readonly name?: string;
  readonly creator?: string;
  readonly trx_hash?: string;
  readonly date_created?: number;
  readonly verify_status?: number;
  readonly compiler?: string;
  readonly call_value?: number;
  readonly call_count?: number;
  readonly caller_count?: number;
  readonly abi?: string;
}

export class TronScanContractCollector implements TronCollector<ContractTarget, TronContractInfo> {
  readonly collectorName = "tron-contract-tronscan";
  readonly sourceName = "tronscan";
  readonly sourceType: DataSourceType = "EXPLORER";

  constructor(private readonly client: TronHttpClient) {}

  supports(target: ContractTarget): boolean {
    return AddressCodec.isHex(target.address) || AddressCodec.isBase58(target.address);
  }

  async collect(target: ContractTarget): Promise<TronContractInfo> {
    const base58Address = AddressCodec.toBase58(target.address);

    const response = await this.client.get<TronScanContractResponse>(
      "/api/contract",
      { contract: base58Address },
    );

    const contract = response.data?.[0];
    if (!contract) {
      throw new BlockchainValidationError(
        `Contract not found: ${base58Address}`,
      );
    }

    let abi: readonly Record<string, unknown>[] | null = null;
    if (contract.abi) {
      try {
        const parsed: unknown = JSON.parse(contract.abi);
        if (Array.isArray(parsed)) {
          abi = parsed as Record<string, unknown>[];
        }
      } catch {
        // ABI string was not valid JSON
      }
    }

    return Object.freeze({
      address: base58Address,
      name: contract.name ?? null,
      creatorAddress: AddressCodec.normalize(contract.creator),
      creationTxHash: contract.trx_hash ?? null,
      createdAt: contract.date_created ?? null,
      isVerified: contract.verify_status === 2,
      compilerVersion: contract.compiler ?? null,
      abi,
      energyFactor: null,
      callCount: contract.call_count ?? null,
      callerCount: contract.caller_count ?? null,
      collectedAt: new Date(),
      source: "tronscan",
    });
  }
}
