const FORBIDDEN_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "credential",
  "email",
  "ip_address",
  "password",
  "secret",
  "session",
  "token",
] as const;

const MAX_PAYLOAD_BYTES = 65_536;
const encoder = new TextEncoder();

export class UnsafeEventPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsafeEventPayloadError";
  }
}

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

function inspect(value: unknown, path: readonly string[]): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, [...path, String(index)]));
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    const forbidden = FORBIDDEN_KEY_FRAGMENTS.find((fragment) =>
      normalized.includes(fragment),
    );
    if (forbidden) {
      throw new UnsafeEventPayloadError(
        `Event payload contains forbidden key at ${[...path, key].join(".")}`,
      );
    }
    inspect(nested, [...path, key]);
  }
}

export function assertSafeEventPayload(
  payload: Readonly<Record<string, unknown>>,
): void {
  inspect(payload, []);

  const encoded = encoder.encode(JSON.stringify(payload));
  if (encoded.byteLength > MAX_PAYLOAD_BYTES) {
    throw new UnsafeEventPayloadError(
      `Event payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }
}

