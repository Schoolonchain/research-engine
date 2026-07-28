import type { TronCollector } from "./tron-collector.js";
import type { TronHttpClient } from "./tron-http-client.js";
import type { DataSourceType } from "./model.js";
import type { TokenTarget, TronTokenInfo } from "./audit-model.js";
import { AddressCodec } from "./normalizers.js";
import { BlockchainValidationError } from "./errors.js";

interface TronScanTokenResponse {
  readonly trc20_tokens?: readonly TronScanTrc20Token[];
}

interface TronScanTrc20Token {
  readonly contract_address?: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly decimals?: number;
  readonly total_supply?: string;
  readonly holders_count?: number;
  readonly transfer_num?: number;
  readonly icon_url?: string;
  readonly description?: string;
  readonly issue_address?: string;
  readonly price?: number;
  readonly market_cap?: number;
  readonly volume_24h?: number;
}

export class TronScanTokenCollector implements TronCollector<TokenTarget, TronTokenInfo> {
  readonly collectorName = "tron-token-tronscan";
  readonly sourceName = "tronscan";
  readonly sourceType: DataSourceType = "EXPLORER";

  constructor(private readonly client: TronHttpClient) {}

  supports(target: TokenTarget): boolean {
    return AddressCodec.isHex(target.contractAddress) || AddressCodec.isBase58(target.contractAddress);
  }

  async collect(target: TokenTarget): Promise<TronTokenInfo> {
    const base58Address = AddressCodec.toBase58(target.contractAddress);

    const response = await this.client.get<TronScanTokenResponse>(
      "/api/token_trc20",
      { contract: base58Address, limit: "1", start: "0" },
    );

    const token = response.trc20_tokens?.[0];
    if (!token) {
      throw new BlockchainValidationError(
        `Token not found: ${base58Address}`,
      );
    }

    return Object.freeze({
      contractAddress: AddressCodec.normalize(token.contract_address ?? "") ?? base58Address,
      name: token.name ?? "",
      symbol: token.symbol ?? "",
      decimals: token.decimals ?? 0,
      totalSupply: token.total_supply ?? "0",
      holderCount: token.holders_count ?? 0,
      transferCount: token.transfer_num ?? 0,
      issuerAddress: AddressCodec.normalize(token.issue_address),
      iconUrl: token.icon_url ?? null,
      description: token.description ?? null,

      priceUsd: token.price ?? null,
      marketCapUsd: token.market_cap ?? null,
      volume24hUsd: token.volume_24h ?? null,

      collectedAt: new Date(),
      source: "tronscan",
    });
  }
}
