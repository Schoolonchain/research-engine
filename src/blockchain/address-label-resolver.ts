import type { TronHttpClient } from "./tron-http-client.js";

export type AddressCategory = "exchange" | "defi" | "foundation" | "token" | "unknown";

export interface AddressLabel {
  readonly address: string;
  readonly name: string;
  readonly category: AddressCategory;
  readonly isContract: boolean;
}

/**
 * Well-known TRON addresses with their human-readable labels.
 * Sourced from TronScan public tags, exchange announcements, and protocol docs.
 */
const KNOWN_ADDRESSES: ReadonlyMap<string, { name: string; category: AddressCategory; isContract: boolean }> = new Map([
  // ── Exchanges ──
  ["TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5", { name: "Poloniex", category: "exchange", isContract: false }],
  ["TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb", { name: "Binance Hot Wallet", category: "exchange", isContract: false }],
  ["TASUAUKXCqvwYjesEWv22pFjRsCeF4NKot", { name: "Upbit Hot Wallet", category: "exchange", isContract: false }],
  ["TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf", { name: "Bitfinex", category: "exchange", isContract: false }],
  ["TMauqkA78pfysSTn8jD1dvEUkjme2gEEdn", { name: "OKX", category: "exchange", isContract: false }],
  ["THHiKCHNQKxrZiRy4rrqy5jitSP3nUvhJY", { name: "Bybit", category: "exchange", isContract: false }],
  ["TLaGjwhvA8XQYSxFAcAXy7Dvuue9eGYitv", { name: "HTX (Huobi)", category: "exchange", isContract: false }],
  ["TG2CMGxnTPgQ6V58kiKd7wbyN8ewtAmY76", { name: "KuCoin", category: "exchange", isContract: false }],
  ["TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81", { name: "Binance Cold Wallet", category: "exchange", isContract: false }],
  ["TRdfD4J3ddSMV5nu5hFDvwzQA4MLS3XdiV", { name: "Binance Cold Wallet 2", category: "exchange", isContract: false }],
  ["TPsMJ3BE9ixSQ7guFbVLZ4eou6SATBSqHH", { name: "Binance Cold Wallet 3", category: "exchange", isContract: false }],
  ["TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ", { name: "Crypto.com", category: "exchange", isContract: false }],
  ["TFvuXyB7AhCV7jZcC9uukZDqrqCvsZQMJh", { name: "Gate.io", category: "exchange", isContract: false }],
  ["TRg6MnpsFXc82ymUPgf5qbj59ibxiEDWvv", { name: "MEXC", category: "exchange", isContract: false }],
  ["TC1GhhC5iGFLuuUthriuUu183P8YWPmQsK", { name: "Binance Staking", category: "exchange", isContract: false }],
  ["TBfJhtGydsNkGt3VVN1mwcXLec9RExMRav", { name: "Poloniex 2", category: "exchange", isContract: false }],

  // ── DeFi / Contratos ──
  ["TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", { name: "WTRX (Wrapped TRX)", category: "defi", isContract: true }],
  ["TE2RzoSV3wFK99w6J9UnnZ4vLfXYoxvRwP", { name: "JustLend (jTRX)", category: "defi", isContract: true }],
  ["TXomXpYhRcCCoEyki5Vg8Si1vUFaamFX9t", { name: "SunSwap V2 Router", category: "defi", isContract: true }],
  ["TWQhCXaWz4eHK4Kd1ErSDHjMFPoPc9czts", { name: "SunSwap Pool", category: "defi", isContract: true }],
  ["TWQUpAgJpjk8Er7DhnME8v3oG2gpagw2z3", { name: "SunSwap Pool", category: "defi", isContract: true }],
  ["TQiXPTvHuqaBW94pqrbgwptkSFXsMLrxnM", { name: "SUN.io Staking", category: "defi", isContract: true }],
  ["TWadTqi8aCMDdgPTdoiUuQAJgsBLhue7uE", { name: "SUN.io Mining", category: "defi", isContract: true }],
  ["TT4gTiH5RszUB8rWHfZQ84oC3gaT4Mxrmx", { name: "SUN.io V2", category: "defi", isContract: true }],
  ["TWpMnUh9pZS1Mf8yyw9WPiS82WYevKzQo2", { name: "SunSwap BTT Pool", category: "defi", isContract: true }],
  ["TP1V18T1UvFMA2RtFzLfa6n4BGkygHtWHZ", { name: "JustLend BTT Pool", category: "defi", isContract: true }],
  ["TEpjT8xbAe3FPCPFziqFfEjLVXaw9NbGXj", { name: "SunSwap Pool", category: "defi", isContract: true }],

  // ── Fundación / Equipo / Reservas ──
  ["TPyjyZfsYaXStgz2NmAraF1uZcMtkgNan5", { name: "Reserva USDD (Sun/HTX)", category: "foundation", isContract: false }],
  ["TScVwVTjqoqPEJ6atnvGCtErWnCyNbzmUL", { name: "SUN Genesis", category: "foundation", isContract: false }],
  ["TZ63tkpcJobcvwsamPknL6JvAAwPLzmbNy", { name: "TRON DAO Reserve", category: "foundation", isContract: false }],
  ["T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", { name: "JUST Foundation", category: "foundation", isContract: false }],
  ["TT1DyeqXaaJkt6UhVYFWUXBXknaXnBudTK", { name: "WIN Foundation", category: "foundation", isContract: false }],
  ["TZJVQuU3CJqBScwoxhRtkxQ7JjsNNrpEag", { name: "JUST Governance", category: "foundation", isContract: false }],
  ["TSFUtqxZyADSmkgLbpoRwyDinr3BWuT6h9", { name: "JUST Team", category: "foundation", isContract: false }],
  ["TXk9LnTnLN7oH96H3sKxJayMxLxR9M4ZD6", { name: "JST Incentive Pool", category: "foundation", isContract: false }],
  ["TDTw5BtaYFAKiCw5jXoNUWGRjQw9mqk9n9", { name: "WIN Rewards Pool", category: "foundation", isContract: false }],
  ["TGY79JnyQju14GkuFsfsGZi3MHrzincTSB", { name: "WIN Staking Rewards", category: "foundation", isContract: false }],

  // ── Token contracts ──
  ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", { name: "USDT (contrato)", category: "token", isContract: true }],
  ["TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S", { name: "SUN (contrato)", category: "token", isContract: true }],
  ["TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4", { name: "BTT (contrato)", category: "token", isContract: true }],
  ["TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9", { name: "JST (contrato)", category: "token", isContract: true }],
  ["TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", { name: "WIN (contrato)", category: "token", isContract: true }],
]);

interface TronScanAccountResponse {
  readonly addressTag?: string;
  readonly address_tag?: string;
  readonly accountType?: number;
  readonly account_type?: number;
  readonly name?: string;
}

/**
 * Resolves labels for a batch of TRON addresses.
 *
 * 1. Checks the hardcoded KNOWN_ADDRESSES map first
 * 2. Falls back to querying TronScan /api/accountv2 for unknown addresses
 * 3. Classifies based on the returned addressTag (looks for keywords)
 */
export class AddressLabelResolver {
  constructor(
    private readonly clients: readonly TronHttpClient[],
  ) {}

  async resolveAll(addresses: readonly string[]): Promise<ReadonlyMap<string, AddressLabel>> {
    const result = new Map<string, AddressLabel>();
    const toFetch: string[] = [];

    // Phase 1: resolve from known map
    for (const addr of addresses) {
      const known = KNOWN_ADDRESSES.get(addr);
      if (known) {
        result.set(addr, { address: addr, ...known });
      } else {
        toFetch.push(addr);
      }
    }

    // Phase 2: fetch unknown from TronScan
    for (const addr of toFetch) {
      const label = await this.fetchAccountLabel(addr);
      result.set(addr, label);
    }

    return result;
  }

  private async fetchAccountLabel(address: string): Promise<AddressLabel> {
    for (const client of this.clients) {
      try {
        const resp = await client.get<TronScanAccountResponse>(
          "/api/accountv2",
          { address },
        );

        const tag = resp.addressTag ?? resp.address_tag ?? resp.name ?? "";
        const acctType = resp.accountType ?? resp.account_type ?? 0;
        const isContract = acctType === 2;

        if (tag) {
          const category = classifyByTag(tag, isContract);
          return { address, name: tag, category, isContract };
        }

        return {
          address,
          name: isContract ? "Contrato" : "",
          category: isContract ? "defi" : "unknown",
          isContract,
        };
      } catch {
        // Try next client
      }
    }

    return { address, name: "", category: "unknown", isContract: false };
  }
}

/** Classify an address by its TronScan tag string. */
function classifyByTag(tag: string, isContract: boolean): AddressCategory {
  const lower = tag.toLowerCase();

  // Exchange keywords
  const exchangeKeywords = [
    "exchange", "binance", "huobi", "htx", "okx", "okex",
    "bybit", "kucoin", "gate.io", "gate ", "bitfinex", "poloniex",
    "upbit", "crypto.com", "mexc", "bitget", "coinbase", "kraken",
    "bitstamp", "bithumb", "coinone", "korbit", "hotbit", "lbank",
  ];
  if (exchangeKeywords.some((kw) => lower.includes(kw))) return "exchange";

  // Foundation / team
  const foundationKeywords = [
    "foundation", "reserve", "team", "treasury", "genesis",
    "dao", "governance", "incentive", "reward", "burn",
  ];
  if (foundationKeywords.some((kw) => lower.includes(kw))) return "foundation";

  // DeFi / contract
  const defiKeywords = [
    "swap", "pool", "lend", "stake", "farm", "bridge",
    "router", "factory", "vault", "market", "sun.io",
    "justlend", "sunswap", "uniswap",
  ];
  if (defiKeywords.some((kw) => lower.includes(kw))) return "defi";

  if (isContract) return "defi";

  return "unknown";
}
