import type { TronHttpClient } from "./tron-http-client.js";

export interface Trc20TokenSummary {
  readonly contractAddress: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly holderCount: number;
  readonly transferCount: number;
  readonly totalSupply: string;
  readonly marketCap: number;
  readonly priceUsd: number;
}

export interface Trc20HolderEntry {
  readonly address: string;
  readonly balance: string;
  readonly balanceNum: number;
}

export interface Trc20TokenAnalysis {
  readonly token: Trc20TokenSummary;
  readonly topHolders: readonly Trc20HolderEntry[];
  readonly totalSupplyNum: number;
}

export interface Trc20RankingsData {
  readonly topTokens: readonly Trc20TokenSummary[];
  readonly tokenAnalyses: readonly Trc20TokenAnalysis[];
  readonly collectedAt: Date;
  readonly source: string;
}

interface TronScanTokenListResponse {
  readonly tokens?: readonly {
    readonly contractAddress?: string;
    readonly name?: string;
    readonly abbr?: string;
    readonly decimals?: number;
    readonly holderCount?: number;
    readonly transferCount?: number;
    readonly totalSupply?: string;
    readonly market_cap?: number;
    readonly priceInUsd?: number;
  }[];
  readonly total?: number;
}

interface TronScanTokenHoldersResponse {
  readonly data?: readonly {
    readonly holder_address?: string;
    readonly balance?: string;
    readonly balance_num?: number;
  }[];
  readonly total?: number;
}

export class Trc20RankingsCollector {
  constructor(
    private readonly tronscan: TronHttpClient,
    private readonly analyzeTopN: number = 5,
  ) {}

  async collect(): Promise<Trc20RankingsData> {
    const topTokens = await this.fetchTopTokens();
    const tokenAnalyses = await this.analyzeTokens(
      topTokens.slice(0, this.analyzeTopN),
    );

    return Object.freeze({
      topTokens: Object.freeze(topTokens),
      tokenAnalyses: Object.freeze(tokenAnalyses),
      collectedAt: new Date(),
      source: "tronscan",
    });
  }

  private async fetchTopTokens(): Promise<readonly Trc20TokenSummary[]> {
    try {
      const response = await this.tronscan.get<TronScanTokenListResponse>(
        "/api/tokens/overview",
        { start: "0", limit: "20", filter: "trc20", sort: "-holderCount" },
      );

      return (response.tokens ?? [])
        .filter((t) => t.contractAddress && t.name)
        .map((t) =>
          Object.freeze({
            contractAddress: t.contractAddress!,
            name: t.name!,
            symbol: t.abbr ?? t.name!,
            decimals: t.decimals ?? 0,
            holderCount: t.holderCount ?? 0,
            transferCount: t.transferCount ?? 0,
            totalSupply: t.totalSupply ?? "0",
            marketCap: t.market_cap ?? 0,
            priceUsd: t.priceInUsd ?? 0,
          }),
        );
    } catch {
      return [];
    }
  }

  private async analyzeTokens(
    tokens: readonly Trc20TokenSummary[],
  ): Promise<readonly Trc20TokenAnalysis[]> {
    const analyses: Trc20TokenAnalysis[] = [];

    for (const token of tokens) {
      const topHolders = await this.fetchTokenHolders(token.contractAddress);
      const totalSupplyNum = this.parseSupply(token.totalSupply, token.decimals);

      analyses.push(
        Object.freeze({
          token,
          topHolders: Object.freeze(topHolders),
          totalSupplyNum,
        }),
      );
    }

    return analyses;
  }

  private async fetchTokenHolders(
    contractAddress: string,
  ): Promise<readonly Trc20HolderEntry[]> {
    try {
      const response = await this.tronscan.get<TronScanTokenHoldersResponse>(
        "/api/tokenholders",
        {
          contract_address: contractAddress,
          start: "0",
          limit: "20",
          sort: "-balance",
        },
      );

      return (response.data ?? [])
        .filter((h) => h.holder_address)
        .map((h) =>
          Object.freeze({
            address: h.holder_address!,
            balance: h.balance ?? "0",
            balanceNum: h.balance_num ?? 0,
          }),
        );
    } catch {
      return [];
    }
  }

  private parseSupply(supply: string, decimals: number): number {
    try {
      const raw = Number(supply);
      if (!Number.isFinite(raw)) return 0;
      return raw / Math.pow(10, decimals);
    } catch {
      return 0;
    }
  }
}
