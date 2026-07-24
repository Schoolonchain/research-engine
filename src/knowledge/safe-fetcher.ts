import { canonicalizeSourceUrl, assertPublicAddress } from "./url-policy.js";
import { UnsafeSourceError } from "./errors.js";

export interface SourceResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface SourceTransportResponse {
  readonly status: number;
  readonly contentType: string;
  readonly contentLength?: number;
  readonly body: Uint8Array;
  readonly redirectUrl?: string;
}

export interface SourceTransport {
  request(input: {
    readonly url: string;
    readonly allowedAddresses: readonly string[];
    readonly timeoutMs: number;
    readonly maxBytes: number;
  }): Promise<SourceTransportResponse>;
}

export interface FetchedSource {
  readonly finalUrl: string;
  readonly contentType: string;
  readonly body: Uint8Array;
}

const ALLOWED_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/json",
  "application/pdf",
]);

export class SafeSourceFetcher {
  public constructor(
    private readonly resolver: SourceResolver,
    private readonly transport: SourceTransport,
    private readonly maxBytes = 1_000_000,
    private readonly timeoutMs = 10_000,
    private readonly maxRedirects = 3,
  ) {}

  public async fetch(rawUrl: string): Promise<FetchedSource> {
    let current = canonicalizeSourceUrl(rawUrl);
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      const parsed = new URL(current);
      const addresses = await this.resolver.resolve(parsed.hostname);
      if (addresses.length === 0) throw new UnsafeSourceError("DNS returned no addresses");
      for (const address of addresses) assertPublicAddress(address);
      const response = await this.transport.request({
        url: current,
        allowedAddresses: Object.freeze([...addresses]),
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
      });
      if (response.redirectUrl) {
        if (redirect === this.maxRedirects) {
          throw new UnsafeSourceError("Too many source redirects");
        }
        current = canonicalizeSourceUrl(
          new URL(response.redirectUrl, current).toString(),
        );
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new UnsafeSourceError(`Source returned HTTP ${response.status}`);
      }
      const mediaType = response.contentType.split(";")[0]?.trim().toLowerCase();
      if (!mediaType || !ALLOWED_TYPES.has(mediaType)) {
        throw new UnsafeSourceError("Source content type is not allowed");
      }
      if (
        response.body.byteLength > this.maxBytes ||
        (response.contentLength !== undefined &&
          response.contentLength > this.maxBytes)
      ) {
        throw new UnsafeSourceError("Source content exceeds size limit");
      }
      return Object.freeze({
        finalUrl: current,
        contentType: mediaType,
        body: response.body,
      });
    }
    throw new UnsafeSourceError("Too many source redirects");
  }
}
