import type { MetricCategory, MetricRecord } from "./metric-types.js";
import type { MetricQuery, MetricStore } from "./metric-store.js";

export class InMemoryMetricStore implements MetricStore {
  private readonly records: MetricRecord[] = [];
  private readonly byKey = new Map<string, MetricRecord[]>();

  async insert(record: MetricRecord): Promise<void> {
    this.records.push(record);
    this.indexRecord(record);
  }

  async insertBatch(records: readonly MetricRecord[]): Promise<void> {
    for (const r of records) {
      this.records.push(r);
      this.indexRecord(r);
    }
  }

  async query(q: MetricQuery): Promise<readonly MetricRecord[]> {
    let results = this.narrowCandidates(q);
    results = this.applyFilters(results, q);

    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (q.limit !== undefined && q.limit > 0) {
      results = results.slice(0, q.limit);
    }

    return Object.freeze(results);
  }

  async latest(
    blockchain: string,
    metricName: string,
    address?: string,
  ): Promise<MetricRecord | null> {
    const key = `${blockchain}:${metricName}`;
    const candidates = this.byKey.get(key);
    if (!candidates || candidates.length === 0) return null;

    let best: MetricRecord | null = null;
    for (const r of candidates) {
      if (address !== undefined && r.address !== address) continue;
      if (!best || r.timestamp.getTime() > best.timestamp.getTime()) {
        best = r;
      }
    }
    return best;
  }

  async count(q: MetricQuery): Promise<number> {
    let candidates = this.narrowCandidates(q);
    candidates = this.applyFilters(candidates, q);
    return candidates.length;
  }

  async categories(blockchain: string): Promise<readonly MetricCategory[]> {
    const cats = new Set<MetricCategory>();
    for (const r of this.records) {
      if (r.blockchain === blockchain) {
        cats.add(r.category);
      }
    }
    return Object.freeze([...cats]);
  }

  get size(): number {
    return this.records.length;
  }

  clear(): void {
    this.records.length = 0;
    this.byKey.clear();
  }

  private indexRecord(record: MetricRecord): void {
    const key = `${record.blockchain}:${record.metricName}`;
    const list = this.byKey.get(key);
    if (list) {
      list.push(record);
    } else {
      this.byKey.set(key, [record]);
    }
  }

  private narrowCandidates(q: MetricQuery): MetricRecord[] {
    if (q.blockchain !== undefined && q.metricName !== undefined) {
      const key = `${q.blockchain}:${q.metricName}`;
      return [...(this.byKey.get(key) ?? [])];
    }
    return [...this.records];
  }

  private applyFilters(
    candidates: MetricRecord[],
    q: MetricQuery,
  ): MetricRecord[] {
    return candidates.filter((r) => {
      if (q.blockchain !== undefined && r.blockchain !== q.blockchain) return false;
      if (q.category !== undefined && r.category !== q.category) return false;
      if (q.metricName !== undefined && r.metricName !== q.metricName) return false;
      if (q.address !== undefined && r.address !== q.address) return false;
      if (q.source !== undefined && r.source !== q.source) return false;
      if (q.from !== undefined && r.timestamp.getTime() < q.from.getTime()) return false;
      if (q.to !== undefined && r.timestamp.getTime() > q.to.getTime()) return false;
      return true;
    });
  }
}
