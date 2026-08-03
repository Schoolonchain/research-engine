import { TronHttpClient } from "../src/blockchain/tron-http-client.js";

const tronscanKey = process.env["TRONSCAN_API_KEY"];
const trongridKey = process.env["TRONGRID_API_KEY"];

const tronscan = new TronHttpClient({
  endpoint: "https://apilist.tronscanapi.com",
  apiKey: tronscanKey,
  rateLimitPerSecond: tronscanKey ? 10 : 3,
  maxRetries: 0,
  timeoutMs: 10_000,
});

const trongrid = new TronHttpClient({
  endpoint: "https://api.trongrid.io",
  apiKey: trongridKey,
  rateLimitPerSecond: trongridKey ? 15 : 5,
  maxRetries: 0,
  timeoutMs: 10_000,
});

interface Probe {
  label: string;
  client: "tronscan" | "trongrid";
  method: "get" | "post";
  path: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}

const probes: Probe[] = [
  // TronScan /api/account/list with different sort params
  { label: "account/list sort=-frozenForEnergyV2", client: "tronscan", method: "get", path: "/api/account/list", params: { sort: "-frozenForEnergyV2", limit: "5", start: "0" } },
  { label: "account/list sort=-totalFrozenV2", client: "tronscan", method: "get", path: "/api/account/list", params: { sort: "-totalFrozenV2", limit: "5", start: "0" } },
  { label: "account/list sort=-energy_consumption", client: "tronscan", method: "get", path: "/api/account/list", params: { sort: "-energy_consumption", limit: "5", start: "0" } },
  { label: "account/list sort=-energyConsumption", client: "tronscan", method: "get", path: "/api/account/list", params: { sort: "-energyConsumption", limit: "5", start: "0" } },

  // Possible resource-specific endpoints
  { label: "resource/accounts", client: "tronscan", method: "get", path: "/api/resource/accounts", params: { limit: "5", start: "0" } },
  { label: "resource/ranking", client: "tronscan", method: "get", path: "/api/resource/ranking", params: { limit: "5", start: "0" } },
  { label: "resource/consumption", client: "tronscan", method: "get", path: "/api/resource/consumption", params: { limit: "5", start: "0" } },
  { label: "resource/consumption/ranking", client: "tronscan", method: "get", path: "/api/resource/consumption/ranking", params: { limit: "5", start: "0" } },

  // Account resource endpoints
  { label: "account/resourcelist", client: "tronscan", method: "get", path: "/api/account/resourcelist", params: { limit: "5", start: "0" } },
  { label: "account/resource/ranking", client: "tronscan", method: "get", path: "/api/account/resource/ranking", params: { limit: "5", start: "0" } },
  { label: "account/ranking", client: "tronscan", method: "get", path: "/api/account/ranking", params: { limit: "5", start: "0" } },

  // Energy-specific endpoints
  { label: "energy/ranking", client: "tronscan", method: "get", path: "/api/energy/ranking", params: { limit: "5", start: "0" } },
  { label: "energy/consumption", client: "tronscan", method: "get", path: "/api/energy/consumption", params: { limit: "5", start: "0" } },
  { label: "energy/consumer/ranking", client: "tronscan", method: "get", path: "/api/energy/consumer/ranking", params: { limit: "5" } },

  // Rankings endpoints (matching URL structure /data/rankings/resource-consumption)
  { label: "rankings/resource-consumption", client: "tronscan", method: "get", path: "/api/rankings/resource-consumption", params: { limit: "5" } },
  { label: "data/rankings/resource-consumption", client: "tronscan", method: "get", path: "/api/data/rankings/resource-consumption", params: { limit: "5" } },
  { label: "ranking/resource", client: "tronscan", method: "get", path: "/api/ranking/resource", params: { limit: "5", start: "0" } },
  { label: "ranking/energy", client: "tronscan", method: "get", path: "/api/ranking/energy", params: { limit: "5" } },

  // Contract endpoints (page /data/rankings/contracts)
  { label: "contract/list sort=-trx_count", client: "tronscan", method: "get", path: "/api/contract", params: { sort: "-trx_count", limit: "5", start: "0" } },
  { label: "contracts/ranking", client: "tronscan", method: "get", path: "/api/contracts/ranking", params: { limit: "5" } },
  { label: "contract/ranking", client: "tronscan", method: "get", path: "/api/contract/ranking", params: { limit: "5" } },

  // Delegation endpoints
  { label: "delegation/ranking", client: "tronscan", method: "get", path: "/api/delegation/ranking", params: { limit: "5" } },
  { label: "resource/delegation", client: "tronscan", method: "get", path: "/api/resource/delegation", params: { limit: "5", start: "0" } },

  // New TronScan v2 endpoints
  { label: "v2/account/list", client: "tronscan", method: "get", path: "/api/v2/account/list", params: { sort: "-energy", limit: "5" } },
  { label: "v1/account/list sort=-frozenV2", client: "tronscan", method: "get", path: "/api/v1/account/list", params: { sort: "-frozenV2", limit: "5" } },

  // Filter-based approaches
  { label: "account/list filter=frozenForEnergyV2", client: "tronscan", method: "get", path: "/api/account/list", params: { sort: "-balance", limit: "5", start: "0", filter: "frozenForEnergyV2" } },
  { label: "account/list type=energy", client: "tronscan", method: "get", path: "/api/account/list", params: { sort: "-balance", limit: "5", start: "0", type: "energy" } },

  // Stake / freeze v2 endpoints
  { label: "stake2/ranking", client: "tronscan", method: "get", path: "/api/stake2/ranking", params: { limit: "5" } },
  { label: "freezev2/ranking", client: "tronscan", method: "get", path: "/api/freezev2/ranking", params: { limit: "5" } },
  { label: "staking/ranking", client: "tronscan", method: "get", path: "/api/staking/ranking", params: { limit: "5" } },
];

function summarize(data: unknown): string {
  if (data === null || data === undefined) return "null";
  if (typeof data !== "object") return String(data).slice(0, 100);
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);
  const parts: string[] = [];
  for (const k of keys.slice(0, 8)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      parts.push(`${k}: Array(${v.length})`);
      if (v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
        parts.push(`  [0] keys: ${Object.keys(v[0] as Record<string, unknown>).join(", ")}`);
      }
    } else if (typeof v === "object" && v !== null) {
      parts.push(`${k}: {${Object.keys(v as Record<string, unknown>).slice(0, 5).join(", ")}}`);
    } else {
      parts.push(`${k}: ${String(v).slice(0, 60)}`);
    }
  }
  if (keys.length > 8) parts.push(`... +${keys.length - 8} more keys`);
  return parts.join("\n    ");
}

async function runProbe(probe: Probe): Promise<void> {
  const client = probe.client === "tronscan" ? tronscan : trongrid;
  try {
    let data: unknown;
    if (probe.method === "get") {
      data = await client.get<unknown>(probe.path, probe.params);
    } else {
      data = await client.post<unknown>(probe.path, probe.body ?? {});
    }

    const hasData = data !== null && data !== undefined && JSON.stringify(data).length > 10;
    const dataStr = JSON.stringify(data);
    const isEmpty = dataStr === "{}" || dataStr === "[]" || dataStr === '{"data":[]}' || dataStr === '{"total":0,"data":[]}';

    if (isEmpty) {
      console.log(`  [EMPTY] ${probe.label}`);
    } else if (hasData) {
      console.log(`  [OK]    ${probe.label}`);
      console.log(`    ${summarize(data)}`);
      console.log(`    raw(first 500): ${dataStr.slice(0, 500)}`);
    } else {
      console.log(`  [??]    ${probe.label} → ${dataStr.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      console.log(`  [404]   ${probe.label}`);
    } else if (msg.includes("403")) {
      console.log(`  [403]   ${probe.label}`);
    } else {
      console.log(`  [ERR]   ${probe.label} → ${msg.slice(0, 100)}`);
    }
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   TRONSCAN API ENDPOINT EXPLORER                ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`TronScan key: ${tronscanKey ? "present" : "missing"}`);
  console.log(`TronGrid key: ${trongridKey ? "present" : "missing"}\n`);

  for (const probe of probes) {
    await runProbe(probe);
  }

  console.log("\n__EXPLORER_DONE__");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
