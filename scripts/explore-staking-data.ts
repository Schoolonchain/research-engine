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
  return hex.slice(0, -8);
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SUN = 1_000_000;

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║   TRON STAKING DATA EXPLORER                        ║");
  console.log("║   Buscando datos reales de frozen V1+V2             ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // ── PART 1: Global resource data from getaccountresource ──
  console.log("═══ PARTE 1: Datos globales de getaccountresource ═══\n");

  const genesisHex = "410000000000000000000000000000000000000000";
  try {
    const resp = await trongrid.post<Record<string, unknown>>(
      "/wallet/getaccountresource",
      { address: genesisHex },
    );
    console.log("Respuesta completa (todos los campos):");
    for (const [key, val] of Object.entries(resp)) {
      console.log(`  ${key}: ${val}`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : err}`);
  }

  // ── PART 2: /wallet/getaccount for real frozen amounts ──
  console.log("\n═══ PARTE 2: /wallet/getaccount — frozen V1+V2 por cuenta ═══\n");

  const ACCOUNTS = [
    { label: "Top staker TU3kjF", address: "TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5" },
    { label: "Top staker TT2T17", address: "TT2T17KZhoDu47i2E4FWxfG79zdkEWkU9N" },
    { label: "Poloniex", address: "TYASr5UV6HEcXatwdFQfmLVUqQQQMUxHLS" },
    { label: "Binance", address: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9" },
    { label: "Top holder TNUC9Q", address: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR" },
  ];

  for (const { label, address } of ACCOUNTS) {
    const hexAddr = base58ToHex(address);
    console.log(`\n── ${label} (${address}) ──`);

    try {
      const acct = await trongrid.post<Record<string, unknown>>(
        "/wallet/getaccount",
        { address: hexAddr, visible: false },
      );

      // V1 freeze data
      const frozen = acct["frozen"] as { frozen_balance?: number; expire_time?: number }[] | undefined;
      const frozenSupply = acct["frozen_supply"] as { frozen_balance?: number }[] | undefined;
      const accountResource = acct["account_resource"] as Record<string, unknown> | undefined;
      const frozenBalanceForEnergy = accountResource?.["frozen_balance_for_energy"] as { frozen_balance?: number } | undefined;

      // V2 freeze data
      const frozenV2 = acct["frozenV2"] as { amount?: number; type?: string }[] | undefined;
      const unfrozenV2 = acct["unfrozenV2"] as { unfreeze_amount?: number; type?: string }[] | undefined;

      // Balance
      const balance = (acct["balance"] as number) ?? 0;
      const netUsage = acct["net_usage"] as number ?? 0;

      // Owner permission
      const ownerPermission = acct["owner_permission"] as Record<string, unknown> | undefined;

      console.log(`  balance (liquid): ${fmt(balance)} SUN (${fmt(balance / SUN)} TRX)`);

      // V1 frozen
      if (frozen && frozen.length > 0) {
        for (const f of frozen) {
          console.log(`  V1 frozen (bandwidth): ${fmt(f.frozen_balance ?? 0)} SUN (${fmt((f.frozen_balance ?? 0) / SUN)} TRX)`);
        }
      } else {
        console.log("  V1 frozen (bandwidth): 0");
      }

      if (frozenBalanceForEnergy?.frozen_balance) {
        console.log(`  V1 frozen (energy): ${fmt(frozenBalanceForEnergy.frozen_balance)} SUN (${fmt(frozenBalanceForEnergy.frozen_balance / SUN)} TRX)`);
      } else {
        console.log("  V1 frozen (energy): 0");
      }

      // V2 frozen
      if (frozenV2 && frozenV2.length > 0) {
        let v2Energy = 0, v2Bandwidth = 0, v2TronPower = 0;
        for (const f of frozenV2) {
          const amt = f.amount ?? 0;
          const type = f.type ?? "BANDWIDTH";
          if (type === "ENERGY") v2Energy = amt;
          else if (type === "TRON_POWER") v2TronPower = amt;
          else v2Bandwidth = amt;
          console.log(`  V2 frozen (${type}): ${fmt(amt)} SUN (${fmt(amt / SUN)} TRX)`);
        }
        console.log(`  V2 total frozen: ${fmt(v2Energy + v2Bandwidth + v2TronPower)} SUN (${fmt((v2Energy + v2Bandwidth + v2TronPower) / SUN)} TRX)`);
      } else {
        console.log("  V2 frozen: none");
      }

      // delegated resources
      const delegatedFrozenV2ForBandwidth = acct["delegated_frozenV2_balance_for_bandwidth"] as number | undefined;
      const delegatedFrozenBalanceForBandwidth = acct["delegated_frozen_balance_for_bandwidth"] as number | undefined;
      const acquiredDelegatedFrozenV2ForEnergy = accountResource?.["acquired_delegated_frozenV2_balance_for_energy"] as number | undefined;
      const delegatedFrozenV2ForEnergy = accountResource?.["delegated_frozenV2_balance_for_energy"] as number | undefined;

      if (delegatedFrozenV2ForBandwidth) console.log(`  delegated_frozenV2_balance_for_bandwidth: ${fmt(delegatedFrozenV2ForBandwidth)} SUN`);
      if (delegatedFrozenBalanceForBandwidth) console.log(`  delegated_frozen_balance_for_bandwidth: ${fmt(delegatedFrozenBalanceForBandwidth)} SUN`);
      if (acquiredDelegatedFrozenV2ForEnergy) console.log(`  acquired_delegated_frozenV2_for_energy: ${fmt(acquiredDelegatedFrozenV2ForEnergy)} SUN`);
      if (delegatedFrozenV2ForEnergy) console.log(`  delegated_frozenV2_for_energy: ${fmt(delegatedFrozenV2ForEnergy)} SUN`);

      // Total account worth
      let totalFrozenV1 = 0;
      if (frozen) for (const f of frozen) totalFrozenV1 += f.frozen_balance ?? 0;
      totalFrozenV1 += frozenBalanceForEnergy?.frozen_balance ?? 0;

      let totalFrozenV2 = 0;
      if (frozenV2) for (const f of frozenV2) totalFrozenV2 += f.amount ?? 0;

      const totalWorth = balance + totalFrozenV1 + totalFrozenV2;
      console.log(`  TOTAL (balance + V1 + V2): ${fmt(totalWorth)} SUN (${fmt(totalWorth / SUN)} TRX)`);

    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(500);
  }

  // ── PART 3: TronScan network overview / statistics ──
  console.log("\n\n═══ PARTE 3: TronScan — estadísticas de red ═══\n");

  const tronscanEndpoints = [
    { path: "/api/system/status", label: "system/status" },
    { path: "/api/token_trc20/overview", label: "token_trc20/overview" },
  ];

  for (const { path, label } of tronscanEndpoints) {
    try {
      const resp = await tronscan.get<Record<string, unknown>>(path, {});
      console.log(`${label}:`);
      const json = JSON.stringify(resp).slice(0, 500);
      console.log(`  ${json}`);
    } catch (err) {
      console.log(`${label}: ERROR — ${err instanceof Error ? err.message : err}`);
    }
    await sleep(300);
  }

  // ── PART 4: TronScan /api/account/list with sort=-power ──
  console.log("\n═══ PARTE 4: TronScan — top por power (staking) ═══\n");

  try {
    const resp = await tronscan.get<{
      data?: {
        address?: string;
        balance?: number;
        totalFrozenV2?: number;
        frozenForEnergyV2?: number;
        frozenForBandWidthV2?: number;
        power?: number;
        frozen_supply?: number;
      }[];
      total?: number;
    }>("/api/account/list", { sort: "-power", limit: "10", start: "0" });

    console.log(`Total accounts: ${resp.total}`);
    for (const a of resp.data ?? []) {
      console.log(`  ${a.address}: balance=${fmt(a.balance ?? 0)} power=${fmt(a.power ?? 0)} totalFrozenV2=${fmt(a.totalFrozenV2 ?? 0)} frozenEnergy=${fmt(a.frozenForEnergyV2 ?? 0)} frozenBW=${fmt(a.frozenForBandWidthV2 ?? 0)}`);
    }
  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : err}`);
  }

  // ── PART 5: Cross-reference global weight with account data ──
  console.log("\n═══ PARTE 5: Verificación cruzada de unidades ═══\n");

  try {
    // Get global weights
    const globals = await trongrid.post<{
      TotalEnergyLimit?: number;
      TotalEnergyWeight?: number;
      TotalNetLimit?: number;
      TotalNetWeight?: number;
    }>("/wallet/getaccountresource", { address: genesisHex });

    const TEL = globals.TotalEnergyLimit ?? 0;
    const TEW = globals.TotalEnergyWeight ?? 0;
    const TNL = globals.TotalNetLimit ?? 0;
    const TNW = globals.TotalNetWeight ?? 0;

    console.log(`TotalEnergyLimit: ${fmt(TEL)}`);
    console.log(`TotalEnergyWeight: ${fmt(TEW)}`);
    console.log(`TotalNetLimit: ${fmt(TNL)}`);
    console.log(`TotalNetWeight: ${fmt(TNW)}`);
    console.log(`Total weight (energy+net): ${fmt(TEW + TNW)}`);

    // Now get account TU3kjF's resources to cross-check
    const hexAddr = base58ToHex("TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5");
    const acctResource = await trongrid.post<{
      EnergyLimit?: number;
      NetLimit?: number;
      freeNetLimit?: number;
    }>("/wallet/getaccountresource", { address: hexAddr });

    const acctEnergyLimit = acctResource.EnergyLimit ?? 0;
    const acctNetLimit = acctResource.NetLimit ?? 0;

    console.log(`\nAccount TU3kjF energy share: ${acctEnergyLimit} / ${TEL} = ${(acctEnergyLimit / TEL * 100).toFixed(4)}%`);
    console.log(`Implied frozen for energy (in weight units): ${((acctEnergyLimit / TEL) * TEW).toFixed(0)}`);

    // Get the account's actual frozen from /wallet/getaccount
    await sleep(300);
    const acctFull = await trongrid.post<{
      frozenV2?: { amount?: number; type?: string }[];
      frozen?: { frozen_balance?: number }[];
      account_resource?: {
        frozen_balance_for_energy?: { frozen_balance?: number };
        delegated_frozenV2_balance_for_energy?: number;
        acquired_delegated_frozenV2_balance_for_energy?: number;
      };
    }>("/wallet/getaccount", { address: hexAddr, visible: false });

    let actualFrozenEnergy = 0;
    let actualFrozenBW = 0;
    if (acctFull.frozenV2) {
      for (const f of acctFull.frozenV2) {
        if (f.type === "ENERGY") actualFrozenEnergy += f.amount ?? 0;
        else if (!f.type || f.type === "BANDWIDTH") actualFrozenBW += f.amount ?? 0;
      }
    }
    // V1
    if (acctFull.frozen) {
      for (const f of acctFull.frozen) actualFrozenBW += f.frozen_balance ?? 0;
    }
    if (acctFull.account_resource?.frozen_balance_for_energy?.frozen_balance) {
      actualFrozenEnergy += acctFull.account_resource.frozen_balance_for_energy.frozen_balance;
    }

    const acquiredEnergy = acctFull.account_resource?.acquired_delegated_frozenV2_balance_for_energy ?? 0;
    const delegatedEnergy = acctFull.account_resource?.delegated_frozenV2_balance_for_energy ?? 0;

    console.log(`\nActual frozen for energy (V1+V2): ${fmt(actualFrozenEnergy)} SUN (${fmt(actualFrozenEnergy / SUN)} TRX)`);
    console.log(`Actual frozen for BW (V1+V2): ${fmt(actualFrozenBW)} SUN (${fmt(actualFrozenBW / SUN)} TRX)`);
    console.log(`Acquired delegated energy: ${fmt(acquiredEnergy)} SUN (${fmt(acquiredEnergy / SUN)} TRX)`);
    console.log(`Delegated out energy: ${fmt(delegatedEnergy)} SUN (${fmt(delegatedEnergy / SUN)} TRX)`);

    // Cross-reference: does the weight unit = SUN?
    // If weight is in SUN: implied frozen = share * TEW
    // Compare with actual frozen
    const impliedFrozenSun = (acctEnergyLimit / TEL) * TEW;
    console.log(`\nImplied frozen (if weight=SUN): ${fmt(impliedFrozenSun)} — actual: ${fmt(actualFrozenEnergy)}`);
    console.log(`Implied frozen (if weight=TRX): ${fmt(impliedFrozenSun * SUN)} — actual: ${fmt(actualFrozenEnergy)}`);
    console.log(`Ratio actual/implied(SUN): ${(actualFrozenEnergy / impliedFrozenSun).toFixed(4)}`);
    if (impliedFrozenSun > 0) {
      console.log(`Ratio actual/implied(TRX): ${(actualFrozenEnergy / (impliedFrozenSun * SUN)).toFixed(6)}`);
    }

    // Also account for acquired delegated energy (increases energy share without own freeze)
    const effectiveFrozen = actualFrozenEnergy + acquiredEnergy - delegatedEnergy;
    console.log(`Effective frozen (own + acquired - delegated): ${fmt(effectiveFrozen)} SUN (${fmt(effectiveFrozen / SUN)} TRX)`);
    console.log(`Ratio effective/implied(SUN): ${(effectiveFrozen / impliedFrozenSun).toFixed(4)}`);

  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : err}`);
  }

  console.log("\n__STAKING_EXPLORER_DONE__");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
