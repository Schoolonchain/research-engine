import type { ActorContext } from "../proposals/model.js";

export type KnowledgeActor = ActorContext;
export type ClaimClassification =
  | "FACT"
  | "CLAIM"
  | "INFERENCE"
  | "UNCERTAINTY";
export type EvidenceStance =
  | "SUPPORTS"
  | "CONTRADICTS"
  | "CONTEXTUALIZES"
  | "UNKNOWN";

export interface AddUrlSourceInput {
  readonly url: string;
  readonly title?: string;
}

export interface AddClaimInput {
  readonly sourcePublicId?: string;
  readonly statement: string;
  readonly classification?: ClaimClassification;
  readonly context?: string;
}

export interface AddEvidenceInput {
  readonly sourcePublicId: string;
  readonly stance: EvidenceStance;
  readonly locator?: string;
  readonly excerpt?: string;
  readonly context?: string;
}

export interface Source {
  readonly publicId: string;
  readonly proposalPublicId: string;
  readonly kind: "URL";
  readonly originalUrl: string;
  readonly canonicalUrl: string;
  readonly title: string | null;
  readonly fetchStatus: string;
  readonly version: number;
}

export interface Claim {
  readonly publicId: string;
  readonly proposalPublicId: string;
  readonly sourcePublicId: string | null;
  readonly statement: string;
  readonly classification: ClaimClassification;
  readonly context: string | null;
  readonly version: number;
}

export interface Evidence {
  readonly publicId: string;
  readonly claimPublicId: string;
  readonly sourcePublicId: string;
  readonly stance: EvidenceStance;
  readonly locator: string | null;
  readonly excerpt: string | null;
  readonly context: string | null;
  readonly version: number;
}
