import type { TronCollector } from "./tron-collector.js";
import type { TronHttpClient } from "./tron-http-client.js";
import type { DataSourceType } from "./model.js";
import { AddressCodec, AmountNormalizer } from "./normalizers.js";

export interface TronStakingInfo {
  readonly address: string;
  readonly frozenBalanceV2Sun: string;
  readonly frozenBandwidthSun: string;
  readonly frozenEnergySun: string;
  readonly delegatedBandwidthSun: string;
  readonly delegatedEnergySun: string;
  readonly canWithdrawSun: string;
  readonly tronPower: number;
  readonly rewardsPendingSun: string;
  readonly votedWitnesses: readonly { readonly address: string; readonly votes: number }[];

  readonly collectedAt: Date;
  readonly source: string;
}

export interface StakingTarget {
  readonly address: string;
}

interface FrozenV2Item {
  readonly amount?: number;
  readonly type?: string;
}

interface TronGridAccountForStaking {
  readonly frozenV2?: readonly FrozenV2Item[];
  readonly account_resource?: {
    readonly delegated_frozen_balance_for_energy?: number;
  };
  readonly delegated_frozen_balance_for_bandwidth?: number;
  readonly votes?: readonly { readonly vote_address?: string; readonly vote_count?: number }[];
}

interface WithdrawResponse {
  readonly amount?: number;
}

interface RewardResponse {
  readonly reward?: number;
}

export class TronStakingCollector implements TronCollector<StakingTarget, TronStakingInfo> {
  readonly collectorName = "tron-staking-trongrid";
  readonly sourceName = "trongrid";
  readonly sourceType: DataSourceType = "API";

  constructor(private readonly client: TronHttpClient) {}

  supports(target: StakingTarget): boolean {
    return AddressCodec.isHex(target.address) || AddressCodec.isBase58(target.address);
  }

  async collect(target: StakingTarget): Promise<TronStakingInfo> {
    const hexAddress = AddressCodec.toHex(target.address);
    const base58Address = AddressCodec.toBase58(target.address);

    const [accountResponse, withdrawResponse, rewardResponse] = await Promise.all([
      this.client.post<TronGridAccountForStaking>("/wallet/getaccount", {
        address: hexAddress,
        visible: false,
      }),
      this.client.post<WithdrawResponse>("/wallet/getcanwithdrawunfreezeamount", {
        owner_address: hexAddress,
        timestamp: Date.now(),
        visible: false,
      }),
      this.client.post<RewardResponse>("/wallet/getReward", {
        address: hexAddress,
        visible: false,
      }),
    ]);

    let frozenBandwidth = 0n;
    let frozenEnergy = 0n;
    if (accountResponse.frozenV2) {
      for (const f of accountResponse.frozenV2) {
        const amount = BigInt(f.amount ?? 0);
        if (f.type === "ENERGY") {
          frozenEnergy += amount;
        } else {
          frozenBandwidth += amount;
        }
      }
    }

    const totalFrozen = frozenBandwidth + frozenEnergy;
    const delegatedBandwidth = BigInt(accountResponse.delegated_frozen_balance_for_bandwidth ?? 0);
    const delegatedEnergy = BigInt(accountResponse.account_resource?.delegated_frozen_balance_for_energy ?? 0);
    const canWithdraw = BigInt(withdrawResponse.amount ?? 0);
    const rewardsPending = BigInt(rewardResponse.reward ?? 0);

    const tronPower = Number(AmountNormalizer.toTrx(totalFrozen.toString()));

    const votedWitnesses = (accountResponse.votes ?? []).map((v) => ({
      address: AddressCodec.normalize(v.vote_address) ?? (v.vote_address ?? ""),
      votes: v.vote_count ?? 0,
    }));

    return Object.freeze({
      address: base58Address,
      frozenBalanceV2Sun: totalFrozen.toString(),
      frozenBandwidthSun: frozenBandwidth.toString(),
      frozenEnergySun: frozenEnergy.toString(),
      delegatedBandwidthSun: delegatedBandwidth.toString(),
      delegatedEnergySun: delegatedEnergy.toString(),
      canWithdrawSun: canWithdraw.toString(),
      tronPower,
      rewardsPendingSun: rewardsPending.toString(),
      votedWitnesses: Object.freeze(votedWitnesses),
      collectedAt: new Date(),
      source: "trongrid",
    });
  }
}
