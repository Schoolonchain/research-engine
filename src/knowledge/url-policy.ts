import { isIP } from "node:net";

import { UnsafeSourceError } from "./errors.js";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);

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
  const blockedV4 =
    /^(10\.|127\.|169\.254\.|192\.168\.|0\.)/u.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[01])\./u.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(normalized) ||
    /^22[4-9]\.|^23\d\./u.test(normalized);
  const blockedV6 =
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("ff");
  if (blockedV4 || blockedV6) {
    throw new UnsafeSourceError("Source resolves to a non-public address");
  }
}
