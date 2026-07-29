import type { TronCollector } from "./tron-collector.js";
import type { TronHttpClient } from "./tron-http-client.js";
import type { DataSourceType } from "./model.js";
import type { TokenTarget, TronTokenInfo } from "./audit-model.js";
import { AddressCodec } from "./normalizers.js";
import { BlockchainValidationError } from "./errors.js";

const ZERO_ADDRESS_HEX = "410000000000000000000000000000000000000000";

const SELECTORS = {
  name: "06fdde03",
  symbol: "95d89b41",
  decimals: "313ce567",
  totalSupply: "18160ddd",
} as const;

interface TriggerConstantResponse {
  readonly constant_result?: readonly string[];
  readonly result?: {
    readonly result?: boolean;
    readonly message?: string;
  };
}

function decodeString(hex: string): string {
  if (hex.length < 128) return "";
  const lengthHex = hex.substring(64, 128);
  const length = parseInt(lengthHex, 16);
  if (length === 0 || !Number.isFinite(length)) return "";
  const dataHex = hex.substring(128, 128 + length * 2);
  const bytes = new Uint8Array(dataHex.length / 2);
  for (let i = 0; i < dataHex.length; i += 2) {
    bytes[i / 2] = parseInt(dataHex.substring(i, i + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function decodeUint(hex: string): bigint {
  if (!hex || hex.length === 0) return 0n;
  return BigInt("0x" + (hex || "0"));
}

export class TronGridTokenCollector implements TronCollector<TokenTarget, TronTokenInfo> {
  readonly collectorName = "tron-token-trongrid";
  readonly sourceName = "trongrid";
  readonly sourceType: DataSourceType = "API";

  constructor(private readonly client: TronHttpClient) {}

  supports(target: TokenTarget): boolean {
    return AddressCodec.isHex(target.contractAddress) || AddressCodec.isBase58(target.contractAddress);
  }

  async collect(target: TokenTarget): Promise<TronTokenInfo> {
    const hexAddress = AddressCodec.toHex(target.contractAddress);
    const base58Address = AddressCodec.toBase58(target.contractAddress);

    const [nameResult, symbolResult, decimalsResult, totalSupplyResult] = await Promise.all([
      this.callConstant(hexAddress, SELECTORS.name),
      this.callConstant(hexAddress, SELECTORS.symbol),
      this.callConstant(hexAddress, SELECTORS.decimals),
      this.callConstant(hexAddress, SELECTORS.totalSupply),
    ]);

    const name = decodeString(nameResult);
    const symbol = decodeString(symbolResult);
    const decimals = Number(decodeUint(decimalsResult));
    const totalSupply = decodeUint(totalSupplyResult).toString();

    if (!name && !symbol) {
      throw new BlockchainValidationError(
        `Address ${base58Address} does not appear to be a TRC20 token`,
      );
    }

    return Object.freeze({
      contractAddress: base58Address,
      name,
      symbol,
      decimals,
      totalSupply,
      holderCount: 0,
      transferCount: 0,
      issuerAddress: null,
      iconUrl: null,
      description: null,
      priceUsd: null,
      marketCapUsd: null,
      volume24hUsd: null,
      collectedAt: new Date(),
      source: "trongrid",
    });
  }

  private async callConstant(contractHex: string, selector: string): Promise<string> {
    const response = await this.client.post<TriggerConstantResponse>(
      "/wallet/triggerconstantcontract",
      {
        owner_address: ZERO_ADDRESS_HEX,
        contract_address: contractHex,
        function_selector: "",
        data: selector,
      },
    );

    if (response.result?.result === false) {
      return "";
    }

    return response.constant_result?.[0] ?? "";
  }
}
