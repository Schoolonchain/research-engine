export const PROPOSAL_STATUSES = [
  "CREATED",
  "OPEN",
  "COLLECTING",
  "THRESHOLD_REACHED",
  "ELIGIBLE",
  "AUTHORIZED",
  "ARCHIVED",
  "REJECTED",
  "DELETION_PENDING",
  "DELETED",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const EVIDENCE_STANCES = [
  "SUPPORTS",
  "CONTRADICTS",
  "CONTEXTUALIZES",
  "UNKNOWN",
] as const;
export type EvidenceStance = (typeof EVIDENCE_STANCES)[number];

export const SCORE_DIMENSIONS = [
  "PRIORITY",
  "PROGRESS",
  "CONFIDENCE",
  "SUPPORT_COUNT",
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export const AUTHORIZATION_TYPES = [
  "ADMIN",
  "PAYMENT",
  "THRESHOLD",
] as const;
export type AuthorizationType = (typeof AUTHORIZATION_TYPES)[number];

export const RESEARCH_JOB_STATUSES = [
  "CREATED",
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type ResearchJobStatus = (typeof RESEARCH_JOB_STATUSES)[number];

export const RESEARCH_RESULT_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "VALIDATED",
  "PUBLISHED",
  "REJECTED",
  "SUPERSEDED",
  "WITHDRAWN",
] as const;
export type ResearchResultStatus =
  (typeof RESEARCH_RESULT_STATUSES)[number];

