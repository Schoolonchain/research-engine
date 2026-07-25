export interface ScorePolicyConfig {
  readonly version: number;
  readonly priorityThreshold: number;
  readonly progressThreshold: number;
  readonly confidenceThreshold: number;
  readonly minimumSupports: number;
}

export interface ScoreDimension {
  readonly dimension: "PRIORITY" | "PROGRESS" | "CONFIDENCE" | "SUPPORT_COUNT";
  readonly value: number;
  readonly policyVersion: number;
  readonly inputs: Readonly<Record<string, number>>;
  readonly explanation: string;
}

export interface ScoreResult {
  readonly proposalPublicId: string;
  readonly dimensions: readonly ScoreDimension[];
  readonly eligible: boolean;
  readonly proposalStatus: string;
}
