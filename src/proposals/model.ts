export const PROPOSAL_VISIBILITIES = [
  "PUBLIC",
  "UNLISTED",
  "PRIVATE",
] as const;
export type ProposalVisibility = (typeof PROPOSAL_VISIBILITIES)[number];

export const ACTOR_ROLES = ["USER", "MODERATOR", "ADMIN"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

export interface ActorContext {
  readonly actorId: string;
  readonly role: ActorRole;
}

export interface Proposal {
  readonly publicId: string;
  readonly authorActorId: string | null;
  readonly title: string;
  readonly centralQuestion: string;
  readonly description: string;
  readonly status: string;
  readonly eligibilitySnapshotCurrent: boolean;
  readonly visibility: ProposalVisibility;
  readonly statusReason: string | null;
  readonly supportCount: number;
  readonly openedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface CreateProposalInput {
  readonly title: string;
  readonly centralQuestion: string;
  readonly description?: string;
  readonly visibility?: ProposalVisibility;
}

export interface UpdateProposalInput {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly centralQuestion?: string;
  readonly description?: string;
  readonly visibility?: ProposalVisibility;
}

export interface TransitionProposalInput {
  readonly expectedVersion: number;
  readonly reason?: string;
}

