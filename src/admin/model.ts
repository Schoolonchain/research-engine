export const ADMINISTRATIVE_ROLES = [
  "MODERATOR",
  "POLICY_ADMIN",
  "VALIDATOR",
] as const;
export type AdministrativeRole = (typeof ADMINISTRATIVE_ROLES)[number];

export interface AdministrativeContext {
  readonly actorId: string;
  readonly identityId: string;
  readonly sessionId: string;
  readonly role: AdministrativeRole;
  readonly mfaVerified: true;
  readonly authenticatedAt: Date;
  readonly reauthenticatedAt: Date;
  readonly expiresAt: Date;
}

export interface VerifiedFederatedPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly authenticationMethods: readonly string[];
  readonly authenticatedAt: Date;
}

export interface AdministrativeSessionCredentials {
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export type ModeratedEntityType = "SOURCE" | "CLAIM" | "EVIDENCE";
export type ModerationDecision = "ACCEPTED" | "REJECTED";
