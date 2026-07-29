import type { TronCollector } from "./tron-collector.js";
import type { TronHttpClient } from "./tron-http-client.js";
import type { DataSourceType } from "./model.js";
import type { AccountTarget, TronAccountInfo, TronTokenBalance } from "./audit-model.js";
import { AddressCodec, AmountNormalizer, PermissionParser } from "./normalizers.js";
import { BlockchainValidationError } from "./errors.js";

interface TronGridAccountResponse {
  readonly address?: string;
  readonly balance?: number;
  readonly create_time?: number;
  readonly latest_opration_time?: number;
  readonly account_name?: string;
  readonly frozen?: readonly { readonly frozen_balance?: number }[];
  readonly frozenV2?: readonly { readonly amount?: number; readonly type?: string }[];
  readonly account_resource?: {
    readonly frozen_balance_for_energy?: {
      readonly frozen_balance?: number;
    };
    readonly delegated_frozen_balance_for_energy?: number;
  };
  readonly delegated_frozen_balance_for_bandwidth?: number;
  readonly owner_permission?: Record<string, unknown>;
  readonly active_permission?: readonly Record<string, unknown>[];
  readonly witness_permission?: Record<string, unknown>;
  readonly trc20?: readonly Record<string, string>[];
  readonly assetV2?: readonly { readonly key?: string; readonly value?: number }[];
}

interface TronGridResourceResponse {
  readonly freeNetLimit?: number;
  readonly freeNetUsed?: number;
  readonly NetLimit?: number;
  readonly NetUsed?: number;
  readonly EnergyLimit?: number;
  readonly EnergyUsed?: number;
  readonly TotalNetLimit?: number;
  readonly TotalNetWeight?: number;
  readonly TotalEnergyLimit?: number;
  readonly TotalEnergyWeight?: number;
}

function computeFrozenBalance(account: TronGridAccountResponse): bigint {
  let total = 0n;

  if (account.frozen) {
    for (const f of account.frozen) {
      total += BigInt(f.frozen_balance ?? 0);
    }
  }

  if (account.frozenV2) {
    for (const f of account.frozenV2) {
      total += BigInt(f.amount ?? 0);
    }
  }

  const energyFrozen = account.account_resource?.frozen_balance_for_energy?.frozen_balance;
  if (energyFrozen) {
    total += BigInt(energyFrozen);
  }

  return total;
}

function computeDelegatedFrozen(account: TronGridAccountResponse): bigint {
  let total = 0n;
  if (account.delegated_frozen_balance_for_bandwidth) {
    total += BigInt(account.delegated_frozen_balance_for_bandwidth);
  }
  if (account.account_resource?.delegated_frozen_balance_for_energy) {
    total += BigInt(account.account_resource.delegated_frozen_balance_for_energy);
  }
  return total;
}

function extractTrc20Balances(trc20: readonly Record<string, string>[] | undefined): TronTokenBalance[] {
  if (!trc20) return [];
  return trc20.flatMap((entry) =>
    Object.entries(entry).map(([contractHex, balance]) => ({
      contractAddress: AddressCodec.normalize(contractHex) ?? contractHex,
      symbol: "",
      name: "",
      balance,
      decimals: 0,
    })),
  );
}

export class TronAccountCollector implements TronCollector<AccountTarget, TronAccountInfo> {
  readonly collectorName = "tron-account-trongrid";
  readonly sourceName = "trongrid";
  readonly sourceType: DataSourceType = "API";

  constructor(private readonly client: TronHttpClient) {}

  supports(target: AccountTarget): boolean {
    return AddressCodec.isHex(target.address) || AddressCodec.isBase58(target.address);
  }

  async collect(target: AccountTarget): Promise<TronAccountInfo> {
    const hexAddress = AddressCodec.toHex(target.address);
    const base58Address = AddressCodec.toBase58(target.address);

    const [accountResponse, resourceResponse] = await Promise.all([
      this.client.post<TronGridAccountResponse>("/wallet/getaccount", {
        address: hexAddress,
        visible: false,
      }),
      this.client.post<TronGridResourceResponse>("/wallet/getaccountresource", {
        address: hexAddress,
        visible: false,
      }),
    ]);

    if (!accountResponse.address && accountResponse.balance === undefined) {
      throw new BlockchainValidationError(
        `Account not found: ${base58Address}`,
      );
    }

    const balance = BigInt(accountResponse.balance ?? 0);
    const frozenBalance = computeFrozenBalance(accountResponse);
    const delegatedFrozen = computeDelegatedFrozen(accountResponse);
    const trc20Balances = extractTrc20Balances(accountResponse.trc20);

    const permInput: Parameters<typeof PermissionParser.parse>[0] = {};
    if (accountResponse.owner_permission) {
      Object.assign(permInput, { owner_permission: accountResponse.owner_permission });
    }
    if (accountResponse.active_permission) {
      Object.assign(permInput, { active_permission: accountResponse.active_permission });
    }
    if (accountResponse.witness_permission) {
      Object.assign(permInput, { witness_permission: accountResponse.witness_permission });
    }
    const permissions = PermissionParser.parse(permInput);

    const accountName = accountResponse.account_name
      ? Buffer.from(accountResponse.account_name, "hex").toString("utf8")
      : null;

    return Object.freeze({
      address: base58Address,
      balanceSun: balance.toString(),
      balanceTrx: AmountNormalizer.toTrx(balance.toString()),
      createTime: accountResponse.create_time ?? null,
      latestOperationTime: accountResponse.latest_opration_time ?? null,
      isContract: false,
      accountName,

      frozenBalanceSun: frozenBalance.toString(),
      energyLimit: resourceResponse.EnergyLimit ?? 0,
      energyUsed: resourceResponse.EnergyUsed ?? 0,
      bandwidthLimit: (resourceResponse.freeNetLimit ?? 0) + (resourceResponse.NetLimit ?? 0),
      bandwidthUsed: (resourceResponse.freeNetUsed ?? 0) + (resourceResponse.NetUsed ?? 0),
      netLimit: resourceResponse.NetLimit ?? 0,
      netUsed: resourceResponse.NetUsed ?? 0,
      delegatedFrozenBalanceSun: delegatedFrozen.toString(),

      trc20Balances: Object.freeze(trc20Balances),
      permissions,

      collectedAt: new Date(),
      source: "trongrid",
    });
  }
}
