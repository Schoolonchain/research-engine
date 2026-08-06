import type { BlockchainConnector } from "./connector.js";
import { BlockchainValidationError } from "./errors.js";

export class ConnectorRegistry {
  public readonly chainId: string;
  public readonly networkName: string;
  private readonly connectors: readonly BlockchainConnector[];

  public constructor(connectors: readonly BlockchainConnector[]) {
    if (connectors.length === 0) {
      throw new BlockchainValidationError("ConnectorRegistry requires at least one connector");
    }

    const first = connectors[0]!;
    for (const connector of connectors) {
      if (connector.chainId !== first.chainId) {
        throw new BlockchainValidationError(
          `All connectors must share the same chainId: expected "${first.chainId}", got "${connector.chainId}" from ${connector.sourceName}`,
        );
      }
    }

    this.chainId = first.chainId;
    this.networkName = first.networkName;
    this.connectors = Object.freeze([...connectors]);
  }

  public primary(): BlockchainConnector {
    return this.connectors[0]!;
  }

  public all(): readonly BlockchainConnector[] {
    return this.connectors;
  }

  public resolve(sourceName?: string): BlockchainConnector {
    if (!sourceName) return this.primary();
    const found = this.connectors.find((c) => c.sourceName === sourceName);
    if (!found) {
      const available = this.connectors.map((c) => c.sourceName).join(", ");
      throw new BlockchainValidationError(
        `Unknown source "${sourceName}". Available: ${available}`,
      );
    }
    return found;
  }
}
