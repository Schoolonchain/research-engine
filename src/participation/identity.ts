import { createHmac } from "node:crypto";

import type { ParticipationIdentity } from "./model.js";
import { ParticipationValidationError } from "./errors.js";

export interface ParticipationKeys {
  readonly subjectKeyHash: string;
  readonly networkKeyHash?: string;
  readonly globalKeyHash: string;
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
  private readonly key: string;

  public constructor(key: string) {
    if (key.length < 32) {
      throw new Error("Participation HMAC key must contain at least 32 characters");
    }
    this.key = key;
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

    return Object.freeze({
      subjectKeyHash: this.hash("subject", subject),
      ...(network
        ? { networkKeyHash: this.hash("network", network) }
        : {}),
      globalKeyHash: this.hash("global", "all-participation"),
    });
  }

  private hash(scope: string, value: string): string {
    return createHmac("sha256", this.key)
      .update(`participation:v1:${scope}:`)
      .update(value)
      .digest("hex");
  }
}

