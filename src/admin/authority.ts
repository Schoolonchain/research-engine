import type { DatabaseExecutor } from "../db/database.js";
import {
  AdministrativeAuthorizationError,
  AdministrativeReauthenticationRequiredError,
} from "./errors.js";
import type { AdministrativeContext, AdministrativeRole } from "./model.js";

export async function assertAdministrativeAuthority(
  tx: DatabaseExecutor,
  context: AdministrativeContext,
  allowedRoles: readonly AdministrativeRole[],
  requireFreshReauthentication = false,
): Promise<AdministrativeRole> {
  const result = await tx.query<{ role: AdministrativeRole }>(
    `SELECT identity.role
     FROM administrative_sessions AS session
     JOIN administrative_identities AS identity ON identity.id = session.identity_id
     WHERE session.id = $1
       AND identity.id = $2
       AND identity.actor_id = $3
       AND identity.status = 'ACTIVE'
       AND session.mfa_verified = true
       AND session.revoked_at IS NULL
       AND session.expires_at > CURRENT_TIMESTAMP
       AND identity.role = ANY($4::text[])
       AND ($5::boolean = false OR
         session.reauthenticated_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes')
     FOR UPDATE OF session, identity`,
    [context.sessionId, context.identityId, context.actorId, [...allowedRoles],
      requireFreshReauthentication],
  );
  const row = result.rows[0];
  if (!row) {
    if (requireFreshReauthentication) {
      throw new AdministrativeReauthenticationRequiredError(
        "Fresh live administrative authority is required",
      );
    }
    throw new AdministrativeAuthorizationError("Live administrative authority is required");
  }
  return row.role;
}
