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

function summarizeObj(data: unknown, depth = 0): string {
  if (data === null || data === undefined) return "null";
  if (typeof data !== "object") return String(data).slice(0, 200);
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  const indent = "      " + "  ".repeat(depth);
  const parts: string[] = [];
  for (const k of keys.slice(0, 15)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      parts.push(`${indent}${k}: Array(${v.length})${v.length > 0 && typeof v[0] === "object" ? ` [0]keys=${Object.keys(v[0] as object).join(",")}` : ""}`);
    } else if (typeof v === "object" && v !== null) {
      parts.push(`${indent}${k}: {${Object.keys(v as Record<string, unknown>).slice(0, 8).join(", ")}}`);
    } else {
      parts.push(`${indent}${k}: ${JSON.stringify(v).slice(0, 100)}`);
    }
  }
  if (keys.length > 15) parts.push(`${indent}... +${keys.length - 15} more keys`);
  return parts.join("\n");
}

async function probeGridEndpoint(
  label: string,
  method: "GET" | "POST",
  path: string,
  bodyOrParams: Record<string, unknown>,
): Promise<unknown> {
  try {
    let data: unknown;
    if (method === "POST") {
      data = await trongrid.post<unknown>(path, bodyOrParams);
    } else {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(bodyOrParams)) params[k] = String(v);
      data = await trongrid.get<unknown>(path, params);
    }
    const json = JSON.stringify(data);
    if (json === "{}" || json === "[]") {
      console.log(`  [EMPTY] ${label}`);
    } else {
      console.log(`  [OK]    ${label}`);
      console.log(summarizeObj(data));
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.match(/(\d{3})/)?.[1] ?? "???";
    console.log(`  [${code}]   ${label} → ${msg.slice(0, 150)}`);
    return null;
  }
}

async function probeScanEndpoint(
  label: string,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  try {
    const data = await tronscan.get<unknown>(path, params);
    const json = JSON.stringify(data);
    if (json === "{}" || json === "[]" || json.includes('"data":[]') && json.includes('"total":0')) {
      console.log(`  [EMPTY] ${label}`);
    } else {
      console.log(`  [OK]    ${label}`);
      console.log(summarizeObj(data));
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.match(/(\d{3})/)?.[1] ?? "???";
    console.log(`  [${code}]   ${label} → ${msg.slice(0, 150)}`);
    return null;
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   TRONGRID + TRONSCAN ENDPOINT EXPLORER (v4)               ║");
  console.log("║   Buscando datos de energía y delegación en ambas APIs     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`TronGrid key: ${trongridKey ? "present" : "missing"}`);
  console.log(`TronScan key: ${tronscanKey ? "present" : "missing"}\n`);

  // ── PART 1: TronGrid - Query known active addresses ──
  console.log("═══════════════════════════════════════════════════");
  console.log("PARTE 1: TronGrid — Cuentas conocidas activas");
  console.log("═══════════════════════════════════════════════════\n");

  for (const { label, address } of KNOWN_ADDRESSES) {
    console.log(`\n── ${label} (${address}) ──`);

    // getaccountresource - energy/bandwidth
    await probeGridEndpoint(
      `getaccountresource`,
      "POST", "/wallet/getaccountresource",
      { address },
    );
    await sleep(500);

    // getdelegatedresourceaccountindexV2 - delegation summary
    await probeGridEndpoint(
      `delegation index`,
      "POST", "/wallet/getdelegatedresourceaccountindexV2",
      { value: address },
    );
    await sleep(500);

    // getaccount - full account details (frozen balances, etc.)
    await probeGridEndpoint(
      `getaccount`,
      "POST", "/wallet/getaccount",
      { address },
    );
    await sleep(500);
  }

  // ── PART 2: TronGrid - Additional endpoints ──
  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("PARTE 2: TronGrid — Endpoints adicionales");
  console.log("═══════════════════════════════════════════════════\n");

  // TronGrid v1 API for a known address
  const usdtAddr = KNOWN_ADDRESSES[0]!.address;

  await probeGridEndpoint(
    "v1/accounts (USDT contract)",
    "GET", `/v1/accounts/${usdtAddr}`,
    {},
  );
  await sleep(500);

  await probeGridEndpoint(
    "v1/accounts/resources (USDT)",
    "GET", `/v1/accounts/${usdtAddr}/resources`,
    {},
  );
  await sleep(500);

  // getaccountnet (bandwidth-specific)
  await probeGridEndpoint(
    "getaccountnet (USDT)",
    "POST", "/wallet/getaccountnet",
    { address: usdtAddr },
  );
  await sleep(500);

  // getdelegatedresource between two specific accounts
  await probeGridEndpoint(
    "getdelegatedresource (USDT→Binance)",
    "POST", "/wallet/getdelegatedresource",
    { fromAddress: usdtAddr, toAddress: KNOWN_ADDRESSES[5]!.address },
  );
  await sleep(500);

  // getcanwithdrawunfreezeamount
  await probeGridEndpoint(
    "getcanwithdrawunfreezeamount (USDT)",
    "POST", "/wallet/getcanwithdrawunfreezeamount",
    { owner_address: usdtAddr },
  );
  await sleep(500);

  // getcanDelegatedMaxSize
  await probeGridEndpoint(
    "getcandelegatedmaxsize (USDT)",
    "POST", "/wallet/getcandelegatedmaxsize",
    { owner_address: usdtAddr, type: 1 },
  );
  await sleep(500);

  // ── PART 3: TronScan - Unexplored endpoints ──
  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("PARTE 3: TronScan — Endpoints no explorados");
  console.log("═══════════════════════════════════════════════════\n");

  // /api/account resources-specific
  await probeScanEndpoint(
    "account/{addr}/resources",
    `/api/account/resources`,
    { address: usdtAddr },
  );
  await sleep(1000);

  // Energy consumption ranking (maybe a different path)
  await probeScanEndpoint(
    "system/energy-ranking",
    "/api/system/energy-ranking",
    { limit: "5" },
  );
  await sleep(1000);

  await probeScanEndpoint(
    "resource/energy/ranking",
    "/api/resource/energy/ranking",
    { limit: "5" },
  );
  await sleep(1000);

  // Account list with filter for frozen
  await probeScanEndpoint(
    "account/list sort=-totalFrozenV2",
    "/api/account/list",
    { sort: "-totalFrozenV2", limit: "5", start: "0" },
  );
  await sleep(1000);

  // Contract calls (high energy use = high contract activity)
  await probeScanEndpoint(
    "contracts/daily-analytics (USDT)",
    "/api/contract/daily-analytics",
    { contract: usdtAddr, limit: "3" },
  );
  await sleep(1000);

  // Contract info
  await probeScanEndpoint(
    "contract info (USDT)",
    "/api/contract",
    { contract: usdtAddr },
  );
  await sleep(1000);

  // /api/contracts (list contracts)
  await probeScanEndpoint(
    "contracts list sort=-trxCount",
    "/api/contracts",
    { sort: "-trxCount", limit: "5", start: "0" },
  );
  await sleep(1000);

  await probeScanEndpoint(
    "contracts list sort=-callValue",
    "/api/contracts",
    { sort: "-callValue", limit: "5", start: "0" },
  );
  await sleep(1000);

  await probeScanEndpoint(
    "contracts list sort=-balance",
    "/api/contracts",
    { sort: "-balance", limit: "5", start: "0" },
  );
  await sleep(1000);

  // Token holder rankings (holders of USDT = active addresses)
  await probeScanEndpoint(
    "token_trc20/holder (USDT top holders)",
    "/api/token_trc20/holders",
    { contract_address: usdtAddr, limit: "5", start: "0" },
  );
  await sleep(1000);

  // Staking/delegation specific
  await probeScanEndpoint(
    "freezev2/list",
    "/api/freezev2/list",
    { sort: "-frozen_balance", limit: "5", start: "0" },
  );
  await sleep(1000);

  await probeScanEndpoint(
    "resources/delegation",
    "/api/resources/delegation",
    { limit: "5" },
  );
  await sleep(1000);

  await probeScanEndpoint(
    "stake2.0/resource/list",
    "/api/stake2.0/resource/list",
    { limit: "5", sort: "-energy" },
  );
  await sleep(1000);

  // ── PART 4: Summary of energy data from known addresses ──
  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("PARTE 4: Resumen de datos de energía encontrados");
  console.log("═══════════════════════════════════════════════════\n");

  const energyResults: { label: string; address: string; energyLimit: number; energyUsed: number; netLimit: number; delegatedTo: number; receivedFrom: number }[] = [];

  for (const { label, address } of KNOWN_ADDRESSES) {
    try {
      const resource = await trongrid.post<{
        EnergyLimit?: number;
        EnergyUsed?: number;
        NetLimit?: number;
        NetUsed?: number;
        freeNetLimit?: number;
        freeNetUsed?: number;
      }>("/wallet/getaccountresource", { address });

      const delegation = await trongrid.post<{
        toAccounts?: string[];
        fromAccounts?: string[];
      }>("/wallet/getdelegatedresourceaccountindexV2", { value: address });

      energyResults.push({
        label,
        address,
        energyLimit: resource.EnergyLimit ?? 0,
        energyUsed: resource.EnergyUsed ?? 0,
        netLimit: (resource.NetLimit ?? 0) + (resource.freeNetLimit ?? 0),
        delegatedTo: delegation.toAccounts?.length ?? 0,
        receivedFrom: delegation.fromAccounts?.length ?? 0,
      });

      await sleep(500);
    } catch (err) {
      console.log(`  [ERROR] ${label}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n  Dirección                          | Energía Límite | Energía Usada | BW Límite | Delegó a | Recibió de");
  console.log("  " + "-".repeat(110));
  for (const r of energyResults) {
    console.log(`  ${r.label.padEnd(36)} | ${String(r.energyLimit).padStart(14)} | ${String(r.energyUsed).padStart(13)} | ${String(r.netLimit).padStart(9)} | ${String(r.delegatedTo).padStart(8)} | ${String(r.receivedFrom).padStart(10)}`);
  }

  console.log("\n__EXPLORER_V4_DONE__");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
