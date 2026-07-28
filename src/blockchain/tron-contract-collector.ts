import type { TronCollector } from "./tron-collector.js";
import type { TronHttpClient } from "./tron-http-client.js";
import type { DataSourceType } from "./model.js";
import type { ContractTarget, TronContractInfo } from "./audit-model.js";
import { AddressCodec } from "./normalizers.js";
import { BlockchainValidationError } from "./errors.js";

interface TronGridContractResponse {
  readonly contract_address?: string;
  readonly origin_address?: string;
  readonly abi?: {
    readonly entrys?: readonly Record<string, unknown>[];
  };
  readonly name?: string;
  readonly origin_energy_limit?: number;
  readonly contract_state?: {
    readonly energy_factor?: number;
  };
}

interface TronGridContractInfoResponse {
  readonly contract_address?: string;
  readonly creator?: {
    readonly address?: string;
    readonly txHash?: string;
  };
  readonly name?: string;
  readonly is_verified?: boolean;
  readonly compiler_version?: string;
}

export class TronGridContractCollector implements TronCollector<ContractTarget, TronContractInfo> {
  readonly collectorName = "tron-contract-trongrid";
  readonly sourceName = "trongrid";
  readonly sourceType: DataSourceType = "API";

  constructor(private readonly client: TronHttpClient) {}

  supports(target: ContractTarget): boolean {
    return AddressCodec.isHex(target.address) || AddressCodec.isBase58(target.address);
  }

  async collect(target: ContractTarget): Promise<TronContractInfo> {
    const hexAddress = AddressCodec.toHex(target.address);
    const base58Address = AddressCodec.toBase58(target.address);

    const [contractResponse, infoResponse] = await Promise.all([
      this.client.post<TronGridContractResponse>("/wallet/getcontract", {
        value: hexAddress,
        visible: false,
      }),
      this.client.post<TronGridContractInfoResponse>("/wallet/getcontractinfo", {
        value: hexAddress,
        visible: false,
      }),
    ]);

    if (!contractResponse.contract_address && !contractResponse.origin_address) {
      throw new BlockchainValidationError(
        `Contract not found: ${base58Address}`,
      );
    }

    const abi = contractResponse.abi?.entrys ?? null;

    return Object.freeze({
      address: base58Address,
      name: infoResponse.name ?? contractResponse.name ?? null,
      creatorAddress: AddressCodec.normalize(
        infoResponse.creator?.address ?? contractResponse.origin_address,
      ),
      creationTxHash: infoResponse.creator?.txHash ?? null,
      createdAt: null,
      isVerified: infoResponse.is_verified ?? false,
      compilerVersion: infoResponse.compiler_version ?? null,
      abi,
      energyFactor: contractResponse.contract_state?.energy_factor ?? null,
      callCount: null,
      callerCount: null,
      collectedAt: new Date(),
      source: "trongrid",
    });
  }
}
