import { createHash } from "node:crypto";
import { ResearchJobService } from "./job-service.js";

export class DeterministicResearchExecutor {
  public constructor(private readonly jobs: ResearchJobService) {}

  public async runNext(workerId: string): Promise<string | null> {
    const lease = await this.jobs.claim(workerId, 30);
    if (!lease) return null;
    const digest = createHash("sha256")
      .update(`${lease.publicId}:${lease.attempts}:phase-8-simulation`)
      .digest("hex");
    await this.jobs.complete(lease.publicId, workerId, { calls: 1, tokens: 1, costMinor: 0 }, {
      kind: "DETERMINISTIC_SIMULATION", digest, provider: null, publication: false,
    });
    return lease.publicId;
  }
}
