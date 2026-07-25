import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { TransactionalDatabase } from "../db/database.js";
import {
  AdministrativeAuthenticationError,
  AdministrativeAuthorizationError,
  AdministrativeValidationError,
} from "./errors.js";
import type {
  AdministrativeContext,
  AdministrativeRole,
  AdministrativeSessionCredentials,
  VerifiedFederatedPrincipal,
} from "./model.js";

interface IdentityRow {
  readonly id: string;
  readonly actor_id: string;
  readonly role: AdministrativeRole;
}
interface SessionRow extends IdentityRow {
  readonly session_id: string;
  readonly mfa_verified: boolean;
  readonly authenticated_at: Date;
  readonly reauthenticated_at: Date;
  readonly expires_at: Date;
  readonly csrf_hash: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function boundedText(value: string, label: string): string {
  const normalized = value.trim().normalize("NFC");
  if (normalized.length < 1 || normalized.length > 500) {
    throw new AdministrativeValidationError(`${label} has invalid length`);
  }
  return normalized;
}

export class AdministrativeSessionService {
  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly sessionLifetimeSeconds = 900,
  ) {
    if (!Number.isSafeInteger(sessionLifetimeSeconds) || sessionLifetimeSeconds < 60) {
      throw new AdministrativeValidationError("Invalid session lifetime");
    }
  }

  public async issue(
    principal: VerifiedFederatedPrincipal,
  ): Promise<AdministrativeSessionCredentials> {
    const issuer = boundedText(principal.issuer, "issuer");
    const subject = boundedText(principal.subject, "subject");
    if (!principal.authenticationMethods.includes("mfa")) {
      throw new AdministrativeAuthenticationError("MFA is required");
    }
    if (
      !(principal.authenticatedAt instanceof Date) ||
      !Number.isFinite(principal.authenticatedAt.getTime())
    ) {
      throw new AdministrativeValidationError("Invalid authentication time");
    }
    const authenticationAge = Date.now() - principal.authenticatedAt.getTime();
    if (authenticationAge < -60_000 || authenticationAge > 5 * 60_000) {
      throw new AdministrativeAuthenticationError(
        "Recent federated authentication is required",
      );
    }
    const accessToken = opaqueToken();
    const csrfToken = opaqueToken();
    return this.database.transaction(async (tx) => {
      const identity = await tx.query<IdentityRow>(
        `SELECT id, actor_id, role FROM administrative_identities
         WHERE issuer = $1 AND subject = $2 AND status = 'ACTIVE'`,
        [issuer, subject],
      );
      const row = identity.rows[0];
      if (!row) throw new AdministrativeAuthenticationError("Unknown identity");
      const inserted = await tx.query<{ expires_at: Date }>(
        `INSERT INTO administrative_sessions (
          identity_id, token_hash, csrf_hash, mfa_verified,
          authenticated_at, reauthenticated_at, expires_at
        ) VALUES (
          $1,$2,$3,true,$4::timestamptz,$4::timestamptz,
          $4::timestamptz + ($5 * INTERVAL '1 second')
        )
        RETURNING expires_at`,
        [row.id, hash(accessToken), hash(csrfToken), principal.authenticatedAt,
          this.sessionLifetimeSeconds],
      );
      return Object.freeze({
        accessToken,
        csrfToken,
        expiresAt: inserted.rows[0]!.expires_at,
      });
    });
  }

  public async authenticate(
    accessToken: string | undefined,
    csrfToken?: string,
    unsafeMethod = false,
  ): Promise<AdministrativeContext> {
    if (!accessToken) throw new AdministrativeAuthenticationError("Session required");
    return this.database.transaction(async (tx) => {
      const result = await tx.query<SessionRow>(
        `SELECT identity.id, identity.actor_id, identity.role,
          session.id AS session_id, session.mfa_verified,
          session.authenticated_at, session.reauthenticated_at,
          session.expires_at, session.csrf_hash
         FROM administrative_sessions AS session
         JOIN administrative_identities AS identity ON identity.id = session.identity_id
         WHERE session.token_hash = $1
           AND session.revoked_at IS NULL
           AND session.expires_at > CURRENT_TIMESTAMP
           AND identity.status = 'ACTIVE'`,
        [hash(accessToken)],
      );
      const row = result.rows[0];
      if (!row || !row.mfa_verified) {
        throw new AdministrativeAuthenticationError("Invalid session");
      }
      if (
        unsafeMethod &&
        (!csrfToken || !equalHash(hash(csrfToken), row.csrf_hash))
      ) {
        throw new AdministrativeAuthorizationError("Invalid CSRF token");
      }
      return Object.freeze({
        actorId: row.actor_id,
        identityId: row.id,
        sessionId: row.session_id,
        role: row.role,
        mfaVerified: true as const,
        authenticatedAt: row.authenticated_at,
        reauthenticatedAt: row.reauthenticated_at,
        expiresAt: row.expires_at,
      });
    });
  }

  public async revoke(context: AdministrativeContext): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        `UPDATE administrative_sessions SET revoked_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND identity_id = $2 AND revoked_at IS NULL`,
        [context.sessionId, context.identityId],
      );
    });
  }
}
