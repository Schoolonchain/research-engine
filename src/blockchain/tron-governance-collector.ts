import type { TronCollector } from "./tron-collector.js";
import type { TronHttpClient } from "./tron-http-client.js";
import type { DataSourceType } from "./model.js";
import { AddressCodec } from "./normalizers.js";

export interface TronWitness {
  readonly address: string;
  readonly url: string;
  readonly isElected: boolean;
  readonly voteCount: number;
  readonly totalProduced: number;
  readonly totalMissed: number;
  readonly productivityPct: number;
  readonly latestBlockNum: number;
}

export interface TronProposal {
  readonly proposalId: number;
  readonly proposerAddress: string;
  readonly state: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly approvalCount: number;
  readonly createTime: number;
  readonly expirationTime: number;
}

export interface TronGovernanceData {
  readonly witnesses: readonly TronWitness[];
  readonly proposals: readonly TronProposal[];
  readonly chainParameters: Readonly<Record<string, string>>;
  readonly totalVotes: number;
  readonly electedCount: number;

  readonly collectedAt: Date;
  readonly source: string;
}

export interface GovernanceTarget {
  readonly scope: "full";
}

interface RawWitness {
  readonly address?: string;
  readonly url?: string;
  readonly isJobs?: boolean;
  readonly voteCount?: number;
  readonly totalProduced?: number;
  readonly totalMissed?: number;
  readonly latestBlockNum?: number;
}

interface WitnessListResponse {
  readonly witnesses?: readonly RawWitness[];
}

interface RawProposal {
  readonly proposal_id?: number;
  readonly proposer_address?: string;
  readonly state?: string;
  readonly parameters?: readonly { readonly key?: number; readonly value?: number }[];
  readonly approvals?: readonly string[];
  readonly create_time?: number;
  readonly expiration_time?: number;
}

interface ProposalListResponse {
  readonly proposals?: readonly RawProposal[];
}

interface ChainParamsResponse {
  readonly chainParameter?: readonly { readonly key?: string; readonly value?: number | string }[];
}

export class TronGovernanceCollector implements TronCollector<GovernanceTarget, TronGovernanceData> {
  readonly collectorName = "tron-governance-trongrid";
  readonly sourceName = "trongrid";
  readonly sourceType: DataSourceType = "API";

  constructor(private readonly client: TronHttpClient) {}

  supports(_target: GovernanceTarget): boolean {
    return true;
  }

  async collect(_target: GovernanceTarget): Promise<TronGovernanceData> {
    const [witnessResponse, proposalResponse, paramsResponse] = await Promise.all([
      this.client.get<WitnessListResponse>("/wallet/listwitnesses"),
      this.client.get<ProposalListResponse>("/wallet/listproposals"),
      this.client.get<ChainParamsResponse>("/wallet/getchainparameters"),
    ]);

    const witnesses = (witnessResponse.witnesses ?? []).map((w): TronWitness => {
      const total = (w.totalProduced ?? 0) + (w.totalMissed ?? 0);
      const productivity = total > 0 ? ((w.totalProduced ?? 0) / total) * 100 : 0;
      return Object.freeze({
        address: AddressCodec.normalize(w.address) ?? (w.address ?? ""),
        url: w.url ?? "",
        isElected: w.isJobs ?? false,
        voteCount: w.voteCount ?? 0,
        totalProduced: w.totalProduced ?? 0,
        totalMissed: w.totalMissed ?? 0,
        productivityPct: Math.round(productivity * 100) / 100,
        latestBlockNum: w.latestBlockNum ?? 0,
      });
    });

    const proposals = (proposalResponse.proposals ?? []).map((p): TronProposal => {
      const params: Record<string, string> = {};
      for (const param of p.parameters ?? []) {
        if (param.key !== undefined) {
          params[String(param.key)] = String(param.value ?? "");
        }
      }
      return Object.freeze({
        proposalId: p.proposal_id ?? 0,
        proposerAddress: AddressCodec.normalize(p.proposer_address) ?? (p.proposer_address ?? ""),
        state: p.state ?? "UNKNOWN",
        parameters: Object.freeze(params),
        approvalCount: p.approvals?.length ?? 0,
        createTime: p.create_time ?? 0,
        expirationTime: p.expiration_time ?? 0,
      });
    });

    const chainParameters: Record<string, string> = {};
    for (const param of paramsResponse.chainParameter ?? []) {
      if (param.key) {
        chainParameters[param.key] = String(param.value ?? "");
      }
    }

    const totalVotes = witnesses.reduce((sum, w) => sum + w.voteCount, 0);
    const electedCount = witnesses.filter((w) => w.isElected).length;

    return Object.freeze({
      witnesses: Object.freeze(witnesses),
      proposals: Object.freeze(proposals),
      chainParameters: Object.freeze(chainParameters),
      totalVotes,
      electedCount,
      collectedAt: new Date(),
      source: "trongrid",
    });
  }
}
