import { createHmac } from "node:crypto";

import type { ParticipationIdentity } from "./model.js";
import type { ParticipationKeyVersion } from "./model.js";
import { ParticipationValidationError } from "./errors.js";

export interface ParticipationKeys {
  readonly subjectKeyHash: string;
  readonly subjectKeyId: string;
  readonly subjectCandidateHashes: readonly string[];
  readonly rateSubjectKeyHash: string;
  readonly networkKeyHash?: string;
  readonly globalKeyHash: string;
}

export interface ParticipationKeyDescriptor {
  readonly id: string;
  readonly verifier: string;
}

function validateOpaqueValue(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 500) {
    throw new ParticipationValidationError(
      `${label} must contain 1 to 500 characters`,
    );
  }
  return normalized;
}

export class ParticipationKeyDeriver {
  private readonly versions: readonly ParticipationKeyVersion[];

  public constructor(versions: readonly ParticipationKeyVersion[]) {
    if (versions.length === 0) {
      throw new Error("Participation keyring must contain at least one key");
    }
    const ids = new Set<string>();
    for (const version of versions) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(version.id)) {
        throw new Error(`Invalid participation key ID: ${version.id}`);
      }
      if (ids.has(version.id)) {
        throw new Error(`Duplicate participation key ID: ${version.id}`);
      }
      if (version.key.length < 32) {
        throw new Error(
          `Participation HMAC key ${version.id} must contain at least 32 characters`,
        );
      }
      ids.add(version.id);
    }
    this.versions = Object.freeze([...versions]);
  }

  public derive(identity: ParticipationIdentity): ParticipationKeys {
    const subject = validateOpaqueValue(identity.subjectId, "subjectId");
    if (!subject) {
      throw new ParticipationValidationError("subjectId is required");
    }
    const network = validateOpaqueValue(
      identity.networkSignal,
      "networkSignal",
    );

    const primary = this.versions[0];
    const stable = this.versions.at(-1);
    if (!primary || !stable) throw new Error("Participation keyring is empty");
    const subjectCandidateHashes = this.versions.map((version) =>
      this.hash(version.key, "subject", subject),
    );

    return Object.freeze({
      subjectKeyHash: subjectCandidateHashes[0] as string,
      subjectKeyId: primary.id,
      subjectCandidateHashes: Object.freeze(subjectCandidateHashes),
      rateSubjectKeyHash: this.hash(stable.key, "subject", subject),
      ...(network
        ? { networkKeyHash: this.hash(stable.key, "network", network) }
        : {}),
      globalKeyHash: this.hash(stable.key, "global", "all-participation"),
    });
  }

  public keyDescriptors(): readonly ParticipationKeyDescriptor[] {
    return Object.freeze(
      this.versions.map((version) =>
        Object.freeze({
          id: version.id,
          verifier: this.hash(
            version.key,
            "key-verifier",
            "immutable-key-material",
          ),
        }),
      ),
    );
  }

  private hash(key: string, scope: string, value: string): string {
    return createHmac("sha256", key)
      .update(`participation:v1:${scope}:`)
      .update(value)
      .digest("hex");
  }
}
