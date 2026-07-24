import { BlockList, isIP } from "node:net";

import { UnsafeSourceError } from "./errors.js";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const NON_GLOBAL = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_GLOBAL.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:2::", 48],
  ["::ffff:0:0", 96], ["2001:db8::", 32], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
] as const) NON_GLOBAL.addSubnet(network, prefix, "ipv6");

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

export function canonicalizeSourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeSourceError("Source URL is invalid");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new UnsafeSourceError("Only HTTP and HTTPS sources are allowed");
  }
  if (url.username || url.password) {
    throw new UnsafeSourceError("Source URL cannot contain credentials");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!hostname || BLOCKED_HOSTS.has(hostname)) {
    throw new UnsafeSourceError("Source hostname is not allowed");
  }
  if (url.port && url.port !== defaultPort(url.protocol)) {
    throw new UnsafeSourceError("Source port is not allowed");
  }
  url.hostname = hostname;
  url.hash = "";
  if (url.port === defaultPort(url.protocol)) url.port = "";
  const removable = [...url.searchParams.keys()].filter((key) =>
    /^(utm_.+|fbclid|gclid)$/iu.test(key),
  );
  for (const key of removable) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

export function assertPublicAddress(address: string): void {
  const version = isIP(address);
  if (version === 0) throw new UnsafeSourceError("DNS returned an invalid IP");
  const normalized = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized)?.[1];
  if (
    (mapped && (isIP(mapped) !== 4 || NON_GLOBAL.check(mapped, "ipv4"))) ||
    NON_GLOBAL.check(normalized, version === 4 ? "ipv4" : "ipv6")
  ) {
    throw new UnsafeSourceError("Source resolves to a non-public address");
  }
}
