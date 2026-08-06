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

interface TronScanHolderEntry {
  readonly holder_address?: string;
  readonly address?: string;
  readonly balance?: string;
  readonly balanceStr?: string;
}

/**
 * Parse a raw token balance string (in smallest units) into a human-readable
 * number using BigInt arithmetic to avoid Number.MAX_SAFE_INTEGER overflow.
 *
 * Example: parseBigIntBalance("8000000000000", 6) → 8_000_000  (USDT)
 * Example: parseBigIntBalance("900000000000000000000000", 18) → 900_000  (BTT)
 *
 * The real TronScan API only returns the `balance` string — it does NOT
 * include a pre-computed `balance_num` field, so this function is the sole
 * source of truth for `Trc20HolderEntry.balanceNum`.
 */
function parseBigIntBalance(rawBalance: string, decimals: number): number {
  try {
    if (!rawBalance || rawBalance === "0") return 0;
    // Strip any decimal point the API might include (defensive)
    const cleaned = rawBalance.includes(".") ? rawBalance.split(".")[0]! : rawBalance;
    const raw = BigInt(cleaned);
    if (raw === 0n) return 0;
    if (decimals <= 0) return Number(raw);

    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const remainder = raw % divisor;

    // Combine integer part + fractional remainder as a float
    return Number(whole) + Number(remainder) / Number(divisor);
  } catch {
    return 0;
  }
}

interface TronScanTokenHoldersResponse {
  /** /api/token_trc20/holders wraps holders in `trc20_tokens` */
  readonly trc20_tokens?: readonly TronScanHolderEntry[];
  /** Some API versions use `data` */
  readonly data?: readonly TronScanHolderEntry[];
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
  private readonly clients: readonly TronHttpClient[];

  constructor(
    tronscan: TronHttpClient,
    private readonly analyzeTopN: number = 5,
    altClients: readonly TronHttpClient[] = [],
  ) {
    this.clients = [tronscan, ...altClients];
  }

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
      const response = await this.clients[0]!.get<TronScanTokenListResponse>(
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
      const topHolders = await this.fetchTokenHolders(token.contractAddress, token.decimals);
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
    decimals: number,
  ): Promise<readonly Trc20HolderEntry[]> {
    // The TronScan v2 API wraps holders in `trc20_tokens` (not `data`).
    // `/api/tokenholders` returns 400 on current hosts, so we only try the trc20 path.
    const paths: { path: string; params: Record<string, string> }[] = [
      {
        path: "/api/token_trc20/holders",
        params: { contract_address: contractAddress, start: "0", limit: "20", order: "desc" },
      },
    ];

    for (const client of this.clients) {
      for (const { path, params } of paths) {
        try {
          const response = await client.get<TronScanTokenHoldersResponse>(path, params);
          const entries = response.trc20_tokens ?? response.data ?? [];
          const holders = entries
            .filter((h) => (h.holder_address ?? h.address))
            .map((h) => {
              const balance = h.balance ?? h.balanceStr ?? "0";
              return Object.freeze({
                address: (h.holder_address ?? h.address)!,
                balance,
                balanceNum: parseBigIntBalance(balance, decimals),
              });
            });
          if (holders.length > 0) return holders;
        } catch {
          // Try next path/client
        }
      }
    }
    return [];
  }

  private parseSupply(supply: string, decimals: number): number {
    // Delegate to BigInt-based parser to handle 18-decimal tokens whose
    // raw totalSupply exceeds Number.MAX_SAFE_INTEGER.
    return parseBigIntBalance(supply, decimals);
  }
}
