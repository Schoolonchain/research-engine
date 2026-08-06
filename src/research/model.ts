export interface AuthorizationLimits {
  readonly maxCostMinor: number;
  readonly currency: string;
  readonly maxDurationSeconds: number;
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxAttempts: number;
}
export interface IssueAuthorizationInput extends AuthorizationLimits {
  readonly proposalPublicId: string;
  readonly type: "ADMIN" | "THRESHOLD";
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
}

export interface AuthorizationView {
  readonly publicId: string;
  readonly status: string;
  readonly policySetHash: string;
  readonly eligibilityScoreRunId: string;
  readonly expiresAt: Date;
}

export interface ResearchJobView {
  readonly publicId: string;
  readonly authorizationPublicId: string;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: Date;
  readonly deadlineAt: Date;
}

export interface ResearchJobLease extends ResearchJobView {
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxCostMinor: number;
}
