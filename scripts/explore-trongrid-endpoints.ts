import { TronHttpClient } from "../src/blockchain/tron-http-client.js";

const trongridKey = process.env["TRONGRID_API_KEY"];
const tronscanKey = process.env["TRONSCAN_API_KEY"];

const trongrid = new TronHttpClient({
  endpoint: "https://api.trongrid.io",
  apiKey: trongridKey,
  rateLimitPerSecond: trongridKey ? 10 : 3,
  maxRetries: 1,
  timeoutMs: 15_000,
});

const tronscan = new TronHttpClient({
  endpoint: "https://apilist.tronscanapi.com",
  apiKey: tronscanKey,
  rateLimitPerSecond: tronscanKey ? 5 : 2,
  maxRetries: 1,
  timeoutMs: 15_000,
});

// ── Base58Check → Hex conversion for TronGrid fullnode API ──
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58ToHex(base58: string): string {
  let num = 0n;
  for (const char of base58) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid Base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  // Remove last 8 hex chars (4-byte checksum)
  return hex.slice(0, -8);
}

const KNOWN_ADDRESSES: { label: string; address: string }[] = [
  { label: "USDT TRC20 Contract", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  { label: "SunSwap V2 Router", address: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax" },
  { label: "JustLend DAO", address: "TX7gysQcJ3CnJJdBR1sMpEHzSxPJNQGeHC" },
  { label: "Sun.io", address: "TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S" },
  { label: "Energy Sun (rental)", address: "TEEgBWKjCMi2ynLjNQ75fT7Rm7TQ5uxJqg" },
  { label: "Binance Hot Wallet", address: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9" },
  { label: "Huobi", address: "TNaRAoLUyYEV2uF7GUrzSjRQTU8v5ZJ5VR" },
  { label: "OKX", address: "TLc5JMDTYHKn1tBAdihDHjPajnTF7GZGCG" },
  { label: "Poloniex", address: "TYASr5UV6HEcXatwdFQfmLVUqQQQMUxHLS" },
  { label: "SunPump", address: "TTfvyrAz3QXdTgBTy5r4NnpUSyrR1pRiGj" },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   TRONGRID + TRONSCAN EXPLORER v5                          ║");
  console.log("║   Base58→Hex fix + v1 API + TronScan contracts             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`TronGrid key: ${trongridKey ? "present" : "missing"}`);
  console.log(`TronScan key: ${tronscanKey ? "present" : "missing"}\n`);

  // ── PART 1: TronGrid v1 API (works with Base58) ──
  console.log("═══════════════════════════════════════════════════");
  console.log("PARTE 1: TronGrid v1 API — /v1/accounts/{address}");
  console.log("(acepta Base58, devuelve account_resource y frozenV2)");
  console.log("═══════════════════════════════════════════════════\n");

  interface V1AccountData {
    label: string;
    address: string;
    balance: number;
    frozenV2: unknown[];
    accountResource: unknown;
    energyWindow?: number;
  }

  const v1Results: V1AccountData[] = [];

  for (const { label, address } of KNOWN_ADDRESSES) {
    try {
      const resp = await trongrid.get<{
        data?: {
          address?: string;
          balance?: number;
          frozenV2?: unknown[];
          account_resource?: unknown;
          net_window_size?: number;
        }[];
        success?: boolean;
      }>(`/v1/accounts/${address}`, {});

      const acct = resp.data?.[0];
      if (acct) {
        v1Results.push({
          label,
          address,
          balance: acct.balance ?? 0,
          frozenV2: acct.frozenV2 ?? [],
          accountResource: acct.account_resource ?? {},
          energyWindow: acct.net_window_size,
        });
        console.log(`  [OK] ${label}`);
        console.log(`       balance: ${fmt(acct.balance ?? 0)} SUN (${((acct.balance ?? 0) / 1e6).toFixed(1)} TRX)`);
        console.log(`       frozenV2: ${JSON.stringify(acct.frozenV2 ?? []).slice(0, 300)}`);
        console.log(`       account_resource: ${JSON.stringify(acct.account_resource ?? {}).slice(0, 300)}`);
      } else {
        console.log(`  [EMPTY] ${label} — no data returned`);
      }
    } catch (err) {
      console.log(`  [ERROR] ${label}: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(300);
  }

  // ── PART 2: TronGrid fullnode with HEX addresses ──
  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("PARTE 2: TronGrid fullnode — direcciones HEX");
  console.log("(getaccountresource + getdelegatedresourceaccountindexV2)");
  console.log("═══════════════════════════════════════════════════\n");

  interface FullnodeResult {
    label: string;
    address: string;
    hexAddress: string;
    energyLimit: number;
    energyUsed: number;
    netLimit: number;
    netUsed: number;
    freeNetLimit: number;
    freeNetUsed: number;
    delegatedTo: number;
    receivedFrom: number;
  }

  const fullnodeResults: FullnodeResult[] = [];

  for (const { label, address } of KNOWN_ADDRESSES) {
    const hexAddr = base58ToHex(address);
    console.log(`\n── ${label} ──`);
    console.log(`   Base58: ${address}`);
    console.log(`   Hex:    ${hexAddr}`);

    let energyLimit = 0, energyUsed = 0, netLimit = 0, netUsed = 0, freeNetLimit = 0, freeNetUsed = 0;
    let delegatedTo = 0, receivedFrom = 0;

    // getaccountresource with hex
    try {
      const resource = await trongrid.post<{
        EnergyLimit?: number;
        EnergyUsed?: number;
        NetLimit?: number;
        NetUsed?: number;
        freeNetLimit?: number;
        freeNetUsed?: number;
        TotalEnergyLimit?: number;
        TotalEnergyWeight?: number;
        Error?: string;
      }>("/wallet/getaccountresource", { address: hexAddr });

      if (resource.Error) {
        console.log(`   getaccountresource: [ERROR] ${resource.Error.slice(0, 150)}`);
      } else {
        energyLimit = resource.EnergyLimit ?? 0;
        energyUsed = resource.EnergyUsed ?? 0;
        netLimit = resource.NetLimit ?? 0;
        netUsed = resource.NetUsed ?? 0;
        freeNetLimit = resource.freeNetLimit ?? 0;
        freeNetUsed = resource.freeNetUsed ?? 0;
        console.log(`   getaccountresource: energyLimit=${fmt(energyLimit)} energyUsed=${fmt(energyUsed)} netLimit=${fmt(netLimit)} freeNetLimit=${fmt(freeNetLimit)}`);
        if (resource.TotalEnergyLimit) {
          console.log(`   (global: TotalEnergyLimit=${fmt(resource.TotalEnergyLimit)} TotalEnergyWeight=${fmt(resource.TotalEnergyWeight ?? 0)})`);
        }
      }
    } catch (err) {
      console.log(`   getaccountresource: [EXCEPTION] ${err instanceof Error ? err.message : err}`);
    }
    await sleep(300);

    // getdelegatedresourceaccountindexV2 with hex
    try {
      const delegation = await trongrid.post<{
        account?: string;
        toAccounts?: string[];
        fromAccounts?: string[];
        Error?: string;
      }>("/wallet/getdelegatedresourceaccountindexV2", { value: hexAddr });

      if (delegation.Error) {
        console.log(`   delegationIndex: [ERROR] ${delegation.Error.slice(0, 150)}`);
      } else {
        delegatedTo = delegation.toAccounts?.length ?? 0;
        receivedFrom = delegation.fromAccounts?.length ?? 0;
        console.log(`   delegationIndex: delegatedTo=${delegatedTo} receivedFrom=${receivedFrom}`);
        if (delegatedTo > 0) {
          console.log(`   toAccounts: ${JSON.stringify(delegation.toAccounts?.slice(0, 5))}`);
        }
        if (receivedFrom > 0) {
          console.log(`   fromAccounts: ${JSON.stringify(delegation.fromAccounts?.slice(0, 5))}`);
        }
      }
    } catch (err) {
      console.log(`   delegationIndex: [EXCEPTION] ${err instanceof Error ? err.message : err}`);
    }
    await sleep(300);

    fullnodeResults.push({
      label, address, hexAddress: hexAddr,
      energyLimit, energyUsed, netLimit, netUsed, freeNetLimit, freeNetUsed,
      delegatedTo, receivedFrom,
    });
  }

  // ── PART 3: TronScan /api/contracts (top by trxCount = proxy for energy use) ──
  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("PARTE 3: TronScan — Top contratos por actividad");
  console.log("(sort=-trxCount = proxy para consumo de energía)");
  console.log("═══════════════════════════════════════════════════\n");

  try {
    const contracts = await tronscan.get<{
      data?: {
        address?: string;
        name?: string;
        balance?: number;
        trxCount?: number;
        tag1?: string;
        date_created?: number;
        verify_status?: number;
      }[];
      total?: number;
      contractCount?: number;
      totalTrigger?: number;
    }>("/api/contracts", { sort: "-trxCount", limit: "20", start: "0" });

    console.log(`  Total contratos: ${fmt(contracts.contractCount ?? 0)}`);
    console.log(`  Total triggers: ${fmt(contracts.totalTrigger ?? 0)}`);
    console.log(`  Top 20 por trxCount:\n`);

    const topContracts = contracts.data ?? [];
    for (let i = 0; i < topContracts.length; i++) {
      const c = topContracts[i]!;
      console.log(`  ${String(i + 1).padStart(2)}. ${(c.name || "Sin nombre").padEnd(30)} | txs: ${fmt(c.trxCount ?? 0).padStart(8)} | balance: ${fmt(c.balance ?? 0).padStart(10)} | ${c.tag1 || ""}`);
      console.log(`      ${c.address}`);
    }

    // Now query energy data for top 10 contracts via TronGrid with hex
    console.log("\n  Consultando energía de top 10 contratos via TronGrid (hex)...\n");

    for (let i = 0; i < Math.min(10, topContracts.length); i++) {
      const c = topContracts[i]!;
      if (!c.address) continue;
      const hexAddr = base58ToHex(c.address);
      try {
        const resource = await trongrid.post<{
          EnergyLimit?: number;
          EnergyUsed?: number;
          NetLimit?: number;
          NetUsed?: number;
          freeNetLimit?: number;
          freeNetUsed?: number;
          Error?: string;
        }>("/wallet/getaccountresource", { address: hexAddr });

        if (resource.Error) {
          console.log(`  ${String(i + 1).padStart(2)}. ${(c.name || c.address!).padEnd(30)} → ERROR: ${resource.Error.slice(0, 80)}`);
        } else {
          const eLimit = resource.EnergyLimit ?? 0;
          const eUsed = resource.EnergyUsed ?? 0;
          const bwLimit = (resource.NetLimit ?? 0) + (resource.freeNetLimit ?? 0);
          console.log(`  ${String(i + 1).padStart(2)}. ${(c.name || c.address!).padEnd(30)} → energy: ${fmt(eLimit)}/${fmt(eUsed)} used | bw: ${fmt(bwLimit)}`);
        }
      } catch (err) {
        console.log(`  ${String(i + 1).padStart(2)}. ${(c.name || c.address!).padEnd(30)} → EXCEPTION: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(300);
    }
  } catch (err) {
    console.log(`  [ERROR] TronScan contracts: ${err instanceof Error ? err.message : err}`);
  }

  // ── PART 4: Summary tables ──
  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("PARTE 4: Resumen — datos de energía y delegación");
  console.log("═══════════════════════════════════════════════════\n");

  console.log("  Fullnode API (hex addresses):");
  console.log("  " + "-".repeat(120));
  console.log(`  ${"Cuenta".padEnd(30)} | ${"Energía Lím".padStart(12)} | ${"Energía Usada".padStart(13)} | ${"BW Lím".padStart(8)} | ${"Delegó a".padStart(8)} | ${"Recibió de".padStart(10)}`);
  console.log("  " + "-".repeat(120));
  for (const r of fullnodeResults) {
    console.log(`  ${r.label.padEnd(30)} | ${fmt(r.energyLimit).padStart(12)} | ${fmt(r.energyUsed).padStart(13)} | ${fmt(r.netLimit + r.freeNetLimit).padStart(8)} | ${String(r.delegatedTo).padStart(8)} | ${String(r.receivedFrom).padStart(10)}`);
  }

  const hasAnyEnergy = fullnodeResults.some(r => r.energyLimit > 0 || r.energyUsed > 0);
  const hasAnyDelegation = fullnodeResults.some(r => r.delegatedTo > 0 || r.receivedFrom > 0);
  console.log(`\n  ¿Alguna cuenta con energía? ${hasAnyEnergy ? "SÍ ✓" : "NO"}`);
  console.log(`  ¿Alguna cuenta con delegación? ${hasAnyDelegation ? "SÍ ✓" : "NO"}`);

  console.log("\n__EXPLORER_V5_DONE__");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
