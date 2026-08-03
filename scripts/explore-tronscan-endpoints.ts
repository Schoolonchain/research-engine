import { TronHttpClient } from "../src/blockchain/tron-http-client.js";

const tronscanKey = process.env["TRONSCAN_API_KEY"];
const trongridKey = process.env["TRONGRID_API_KEY"];

const tronscan = new TronHttpClient({
  endpoint: "https://apilist.tronscanapi.com",
  apiKey: tronscanKey,
  rateLimitPerSecond: 1,
  maxRetries: 1,
  timeoutMs: 15_000,
});

interface Probe {
  label: string;
  method: "get" | "post";
  path: string;
  params?: Record<string, string>;
}

const probes: Probe[] = [
  // Endpoints that returned 429 (exist but rate-limited) - most promising first
  { label: "resource/ranking", method: "get", path: "/api/resource/ranking", params: { limit: "5", start: "0" } },
  { label: "resource/consumption", method: "get", path: "/api/resource/consumption", params: { limit: "5", start: "0" } },
  { label: "energy/ranking", method: "get", path: "/api/energy/ranking", params: { limit: "5", start: "0" } },
  { label: "energy/consumption", method: "get", path: "/api/energy/consumption", params: { limit: "5", start: "0" } },
  { label: "ranking/resource", method: "get", path: "/api/ranking/resource", params: { limit: "5", start: "0" } },
  { label: "ranking/energy", method: "get", path: "/api/ranking/energy", params: { limit: "5", start: "0" } },
  { label: "account/ranking", method: "get", path: "/api/account/ranking", params: { limit: "5", start: "0" } },
  { label: "account/resourcelist", method: "get", path: "/api/account/resourcelist", params: { limit: "5", start: "0" } },
  { label: "delegation/ranking", method: "get", path: "/api/delegation/ranking", params: { limit: "5", start: "0" } },
  { label: "resource/delegation", method: "get", path: "/api/resource/delegation", params: { limit: "5", start: "0" } },
  { label: "contract/ranking", method: "get", path: "/api/contract/ranking", params: { limit: "5", start: "0" } },
  { label: "staking/ranking", method: "get", path: "/api/staking/ranking", params: { limit: "5", start: "0" } },
  { label: "v2/account/list sort=-energy", method: "get", path: "/api/v2/account/list", params: { sort: "-energy", limit: "5" } },
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
        parts.push(`  [0] keys: ${Object.keys(v[0] as Record<string, unknown>).join(", ")}`);
        const first = v[0] as Record<string, unknown>;
        for (const fk of Object.keys(first).slice(0, 6)) {
          const fv = first[fk];
          parts.push(`  [0].${fk} = ${JSON.stringify(fv).slice(0, 80)}`);
        }
      }
    } else if (typeof v === "object" && v !== null) {
      parts.push(`${k}: {${Object.keys(v as Record<string, unknown>).slice(0, 8).join(", ")}}`);
    } else {
      parts.push(`${k}: ${String(v).slice(0, 80)}`);
    }
  }
  if (keys.length > 10) parts.push(`... +${keys.length - 10} more keys`);
  return parts.join("\n    ");
}

async function runProbe(probe: Probe): Promise<void> {
  try {
    const data = await tronscan.get<unknown>(probe.path, probe.params);

    const dataStr = JSON.stringify(data);
    const isEmpty = dataStr === "{}" || dataStr === "[]" || dataStr === '{"data":[]}' || dataStr === '{"total":0,"data":[]}';

    if (isEmpty) {
      console.log(`  [EMPTY] ${probe.label}`);
    } else if (dataStr.length > 10) {
      console.log(`  [OK]    ${probe.label}`);
      console.log(`    ${summarize(data)}`);
      console.log(`    raw(first 800): ${dataStr.slice(0, 800)}`);
    } else {
      console.log(`  [??]    ${probe.label} → ${dataStr.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      console.log(`  [404]   ${probe.label}`);
    } else if (msg.includes("400")) {
      console.log(`  [400]   ${probe.label}`);
    } else if (msg.includes("429")) {
      console.log(`  [429]   ${probe.label} (rate limited)`);
    } else {
      console.log(`  [ERR]   ${probe.label} → ${msg.slice(0, 120)}`);
    }
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   TRONSCAN API ENDPOINT EXPLORER (v2)           ║");
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
