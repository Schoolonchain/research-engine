import type { TronCollector } from "./tron-collector.js";
import type { TronHttpClient } from "./tron-http-client.js";
import type { DataSourceType } from "./model.js";
import type { AccountTarget, TronAccountInfo, TronTokenBalance } from "./audit-model.js";
import { AddressCodec, AmountNormalizer, PermissionParser } from "./normalizers.js";
import { BlockchainValidationError } from "./errors.js";

interface TronScanTokenItem {
  readonly tokenId?: string;
  readonly tokenAbbr?: string;
  readonly tokenName?: string;
  readonly balance?: string;
  readonly tokenDecimal?: number;
  readonly tokenType?: string;
}

interface TronScanAccountResponse {
  readonly address?: string;
  readonly balance?: number;
  readonly create_time?: number;
  readonly latest_operation_time?: number;
  readonly accountType?: number;
  readonly name?: string;
  readonly totalFrozen?: number;
  readonly frozenForBandWidth?: number;
  readonly frozenForEnergy?: number;
  readonly delegatedFrozen?: number;

  readonly bandwidth?: {
    readonly freeNetLimit?: number;
    readonly freeNetUsed?: number;
    readonly netLimit?: number;
    readonly netUsed?: number;
    readonly energyLimit?: number;
    readonly energyUsed?: number;
  };

  readonly withPriceTokens?: readonly TronScanTokenItem[];

  readonly ownerPermission?: Record<string, unknown>;
  readonly activePermission?: readonly Record<string, unknown>[];
  readonly witnessPermission?: Record<string, unknown>;

  readonly date_created?: number;
}

function extractTrc20Balances(tokens: readonly TronScanTokenItem[] | undefined): TronTokenBalance[] {
  if (!tokens) return [];
  return tokens
    .filter((t) => t.tokenType === "trc20")
    .map((t) => ({
      contractAddress: AddressCodec.normalize(t.tokenId ?? "") ?? (t.tokenId ?? ""),
      symbol: t.tokenAbbr ?? "",
      name: t.tokenName ?? "",
      balance: t.balance ?? "0",
      decimals: t.tokenDecimal ?? 0,
    }));
}

export class TronScanAccountCollector implements TronCollector<AccountTarget, TronAccountInfo> {
  readonly collectorName = "tron-account-tronscan";
  readonly sourceName = "tronscan";
  readonly sourceType: DataSourceType = "EXPLORER";

  constructor(private readonly client: TronHttpClient) {}

  supports(target: AccountTarget): boolean {
    return AddressCodec.isHex(target.address) || AddressCodec.isBase58(target.address);
  }

  async collect(target: AccountTarget): Promise<TronAccountInfo> {
    const base58Address = AddressCodec.toBase58(target.address);

    const response = await this.client.get<TronScanAccountResponse>(
      "/api/accountv2",
      { address: base58Address },
    );

    if (!response.address) {
      throw new BlockchainValidationError(
        `Account not found: ${base58Address}`,
      );
    }

    const balance = BigInt(response.balance ?? 0);
    const frozenBalance = BigInt(response.totalFrozen ?? 0);
    const delegatedFrozen = BigInt(response.delegatedFrozen ?? 0);
    const trc20Balances = extractTrc20Balances(response.withPriceTokens);
    const bw = response.bandwidth;

    const permInput: Parameters<typeof PermissionParser.parse>[0] = {};
    if (response.ownerPermission) {
      Object.assign(permInput, { owner_permission: response.ownerPermission });
    }
    if (response.activePermission) {
      Object.assign(permInput, { active_permission: response.activePermission });
    }
    if (response.witnessPermission) {
      Object.assign(permInput, { witness_permission: response.witnessPermission });
    }
    const permissions = PermissionParser.parse(permInput);

    return Object.freeze({
      address: base58Address,
      balanceSun: balance.toString(),
      balanceTrx: AmountNormalizer.toTrx(balance.toString()),
      createTime: response.create_time ?? response.date_created ?? null,
      latestOperationTime: response.latest_operation_time ?? null,
      isContract: response.accountType === 2,
      accountName: response.name ?? null,

      frozenBalanceSun: frozenBalance.toString(),
      energyLimit: bw?.energyLimit ?? 0,
      energyUsed: bw?.energyUsed ?? 0,
      bandwidthLimit: (bw?.freeNetLimit ?? 0) + (bw?.netLimit ?? 0),
      bandwidthUsed: (bw?.freeNetUsed ?? 0) + (bw?.netUsed ?? 0),
      netLimit: bw?.netLimit ?? 0,
      netUsed: bw?.netUsed ?? 0,
      delegatedFrozenBalanceSun: delegatedFrozen.toString(),

      trc20Balances: Object.freeze(trc20Balances),
      permissions,

      collectedAt: new Date(),
      source: "tronscan",
    });
  }
}
