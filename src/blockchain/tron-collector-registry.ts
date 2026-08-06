import type { TronCollector } from "./tron-collector.js";
import { BlockchainValidationError } from "./errors.js";

export class TronCollectorRegistry {
  private readonly collectors = new Map<string, TronCollector<unknown, unknown>[]>();

  register<T, R>(type: string, collector: TronCollector<T, R>): void {
    let list = this.collectors.get(type);
    if (!list) {
      list = [];
      this.collectors.set(type, list);
    }
    const duplicate = list.find((c) => c.sourceName === collector.sourceName);
    if (duplicate) {
      throw new BlockchainValidationError(
        `Collector "${collector.collectorName}" from source "${collector.sourceName}" already registered for type "${type}"`,
      );
    }
    list.push(collector as TronCollector<unknown, unknown>);
  }

  resolve<T, R>(type: string, sourceName?: string): TronCollector<T, R> {
    const list = this.collectors.get(type);
    if (!list || list.length === 0) {
      throw new BlockchainValidationError(
        `No collectors registered for type "${type}"`,
      );
    }

    if (!sourceName) {
      return list[0]! as TronCollector<T, R>;
    }

    const found = list.find((c) => c.sourceName === sourceName);
    if (!found) {
      const available = list.map((c) => c.sourceName).join(", ");
      throw new BlockchainValidationError(
        `No collector from source "${sourceName}" for type "${type}". Available: ${available}`,
      );
    }

    return found as TronCollector<T, R>;
  }

  all(type: string): readonly TronCollector<unknown, unknown>[] {
    return Object.freeze([...(this.collectors.get(type) ?? [])]);
  }

  canCollect(type: string): boolean {
    const list = this.collectors.get(type);
    return list !== undefined && list.length > 0;
  }

  registeredTypes(): readonly string[] {
    return Object.freeze([...this.collectors.keys()]);
  }
}
