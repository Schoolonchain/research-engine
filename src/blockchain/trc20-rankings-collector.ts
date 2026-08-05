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

interface TronScanTokenEntry {
  readonly contractAddress?: string;
  readonly contract_address?: string;
  readonly name?: string;
  readonly abbr?: string;
  readonly decimals?: number;
  readonly decimal?: number;
  readonly holderCount?: number;
  readonly nrOfTokenHolders?: number;
  readonly transferCount?: number;
  readonly totalSupply?: string;
  readonly total_supply?: string;
  readonly market_cap?: number;
  readonly marketcap?: number;
  readonly priceInUsd?: number;
  readonly price?: number;
}

interface TronScanTokenListResponse {
  /** /api/tokens/overview wraps in `tokens`, /api/token/all wraps in `data` or `tokens` */
  readonly tokens?: readonly TronScanTokenEntry[];
  readonly data?: readonly TronScanTokenEntry[];
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

/**
 * Well-known TRC-20 tokens on TRON mainnet.
 * Used as fallback when the token listing API is unavailable (returns 404 on
 * some TronScan API hosts). Holder data is still fetched live via /api/tokenholders.
 */
const WELL_KNOWN_TOKENS: readonly Trc20TokenSummary[] = Object.freeze([
  { contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", name: "Tether USD", symbol: "USDT", decimals: 6, holderCount: 0, transferCount: 0, totalSupply: "0", marketCap: 0, priceUsd: 0 },
  { contractAddress: "TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S", name: "Sun Token", symbol: "SUN", decimals: 18, holderCount: 0, transferCount: 0, totalSupply: "0", marketCap: 0, priceUsd: 0 },
  { contractAddress: "TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4", name: "BitTorrent", symbol: "BTT", decimals: 18, holderCount: 0, transferCount: 0, totalSupply: "0", marketCap: 0, priceUsd: 0 },
  { contractAddress: "TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9", name: "JUST", symbol: "JST", decimals: 18, holderCount: 0, transferCount: 0, totalSupply: "0", marketCap: 0, priceUsd: 0 },
  { contractAddress: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", name: "WINkLink", symbol: "WIN", decimals: 6, holderCount: 0, transferCount: 0, totalSupply: "0", marketCap: 0, priceUsd: 0 },
  { contractAddress: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", name: "Wrapped TRX", symbol: "WTRX", decimals: 6, holderCount: 0, transferCount: 0, totalSupply: "0", marketCap: 0, priceUsd: 0 },
  { contractAddress: "TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT", name: "USD Coin", symbol: "USDC", decimals: 6, holderCount: 0, transferCount: 0, totalSupply: "0", marketCap: 0, priceUsd: 0 },
  { contractAddress: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4", name: "TrueUSD", symbol: "TUSD", decimals: 18, holderCount: 0, transferCount: 0, totalSupply: "0", marketCap: 0, priceUsd: 0 },
]);

export class Trc20RankingsCollector {
  constructor(
    private readonly tronscan: TronHttpClient,
    private readonly analyzeTopN: number = 5,
  ) {}

  async collect(): Promise<Trc20RankingsData> {
    let topTokens = await this.fetchTopTokens();

    // Fallback: if the token listing API returned nothing, use well-known tokens
    // so we still fetch live holder data for major tokens.
    if (topTokens.length === 0) {
      topTokens = WELL_KNOWN_TOKENS;
    }

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
      // TronScan API v2 uses /api/token/all (not /api/tokens/overview which returns 404).
      // See https://docs.tronscan.org/api-endpoints/tokens
      const response = await this.tronscan.get<TronScanTokenListResponse>(
        "/api/token/all",
        { start: "0", limit: "20", filter: "trc20", sort: "holderCount", order: "desc" },
      );

      const entries = response.tokens ?? response.data ?? [];
      return entries
        .filter((t) => (t.contractAddress ?? t.contract_address) && t.name)
        .map((t) =>
          Object.freeze({
            contractAddress: (t.contractAddress ?? t.contract_address)!,
            name: t.name!,
            symbol: t.abbr ?? t.name!,
            decimals: t.decimals ?? t.decimal ?? 0,
            holderCount: t.holderCount ?? t.nrOfTokenHolders ?? 0,
            transferCount: t.transferCount ?? 0,
            totalSupply: t.totalSupply ?? t.total_supply ?? "0",
            marketCap: t.market_cap ?? t.marketcap ?? 0,
            priceUsd: t.priceInUsd ?? t.price ?? 0,
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
