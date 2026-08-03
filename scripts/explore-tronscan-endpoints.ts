import { TronHttpClient } from "../src/blockchain/tron-http-client.js";

const tronscanKey = process.env["TRONSCAN_API_KEY"];

const tronscan = new TronHttpClient({
  endpoint: "https://apilist.tronscanapi.com",
  apiKey: tronscanKey,
  rateLimitPerSecond: 1,
  maxRetries: 1,
  timeoutMs: 15_000,
});

interface Probe {
  label: string;
  path: string;
  params?: Record<string, string>;
}

const probes: Probe[] = [
  // Known working sorts for reference
  { label: "account/list sort=-balance (control)", path: "/api/account/list", params: { sort: "-balance", limit: "2", start: "0" } },

  // TronScan internal patterns (based on their UI pages)
  { label: "account/list sort=-energy", path: "/api/account/list", params: { sort: "-energy", limit: "5", start: "0" } },
  { label: "account/list sort=-energyUsage", path: "/api/account/list", params: { sort: "-energyUsage", limit: "5", start: "0" } },
  { label: "account/list sort=-net_usage", path: "/api/account/list", params: { sort: "-net_usage", limit: "5", start: "0" } },
  { label: "account/list sort=-frozen", path: "/api/account/list", params: { sort: "-frozen", limit: "5", start: "0" } },
  { label: "account/list sort=-tronPowerUsed", path: "/api/account/list", params: { sort: "-tronPowerUsed", limit: "5", start: "0" } },

  // Account list with explicit secondary params
  { label: "account/list sort=-power&type=1", path: "/api/account/list", params: { sort: "-power", limit: "5", start: "0", type: "1" } },
  { label: "account/list sort=-power&type=2", path: "/api/account/list", params: { sort: "-power", limit: "5", start: "0", type: "2" } },

  // Contract-based (contracts consume the most energy)
  { label: "contract sort=-energy_consumption", path: "/api/contract", params: { sort: "-energy_consumption", limit: "5", start: "0" } },
  { label: "contract sort=-energy_factor", path: "/api/contract", params: { sort: "-energy_factor", limit: "5", start: "0" } },
  { label: "contract sort=-call_value", path: "/api/contract", params: { sort: "-call_value", limit: "5", start: "0" } },
  { label: "contract sort=-trx_count", path: "/api/contract", params: { sort: "-trx_count", limit: "5", start: "0" } },
  { label: "contract sort=-balance", path: "/api/contract", params: { sort: "-balance", limit: "5", start: "0" } },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(data: unknown): string {
  if (data === null || data === undefined) return "null";
  if (typeof data !== "object") return String(data).slice(0, 200);
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);
  const parts: string[] = [];
  for (const k of keys.slice(0, 10)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      parts.push(`${k}: Array(${v.length})`);
      if (v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
        const first = v[0] as Record<string, unknown>;
        parts.push(`  [0] keys: ${Object.keys(first).join(", ")}`);
        for (const fk of Object.keys(first).slice(0, 8)) {
          parts.push(`  [0].${fk} = ${JSON.stringify(first[fk]).slice(0, 100)}`);
        }
      }
    } else if (typeof v === "object" && v !== null) {
      parts.push(`${k}: {${Object.keys(v as Record<string, unknown>).slice(0, 8).join(", ")}}`);
    } else {
      parts.push(`${k}: ${String(v).slice(0, 80)}`);
    }
  }
  return parts.join("\n    ");
}

async function runProbe(probe: Probe): Promise<void> {
  try {
    const data = await tronscan.get<unknown>(probe.path, probe.params);
    const dataStr = JSON.stringify(data);
    const isEmpty = dataStr === "{}" || dataStr === "[]" ||
      dataStr === '{"data":[]}' || dataStr === '{"total":0,"data":[]}' ||
      (dataStr.includes('"data":[]') && dataStr.includes('"total":0'));

    if (isEmpty) {
      console.log(`  [EMPTY] ${probe.label}`);
    } else if (dataStr.length > 10) {
      console.log(`  [OK]    ${probe.label}`);
      console.log(`    ${summarize(data)}`);
      console.log(`    raw(first 1000): ${dataStr.slice(0, 1000)}`);
    } else {
      console.log(`  [??]    ${probe.label} → ${dataStr.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.match(/(\d{3})/)?.[1] ?? "???";
    console.log(`  [${code}]   ${probe.label}`);
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   TRONSCAN API ENDPOINT EXPLORER (v3)           ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`TronScan key: ${tronscanKey ? "present" : "missing"}`);
  console.log(`Probes: ${probes.length} (2s pause between each)\n`);

  for (let i = 0; i < probes.length; i++) {
    if (i > 0) await sleep(2000);
    await runProbe(probes[i]!);
  }

  console.log("\n__EXPLORER_DONE__");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
