CREATE TABLE administrative_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL UNIQUE REFERENCES actors(id) ON DELETE RESTRICT,
  issuer text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 500),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 500),
  role text NOT NULL CHECK (role IN ('MODERATOR', 'POLICY_ADMIN', 'VALIDATOR')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, subject)
);

CREATE TABLE administrative_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES administrative_identities(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_hash char(64) NOT NULL,
  mfa_verified boolean NOT NULL,
  authenticated_at timestamptz NOT NULL,
  reauthenticated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > authenticated_at),
  CHECK (reauthenticated_at >= authenticated_at),
  CHECK (reauthenticated_at <= expires_at)
);

CREATE INDEX administrative_sessions_active_idx
  ON administrative_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE administrative_action_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  session_id uuid REFERENCES administrative_sessions(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 200),
  target_type text NOT NULL CHECK (char_length(target_type) BETWEEN 1 AND 100),
  target_id uuid NOT NULL,
  correlation_id uuid NOT NULL UNIQUE,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER administrative_action_audit_append_only
BEFORE UPDATE OR DELETE ON administrative_action_audit
FOR EACH ROW EXECUTE FUNCTION prevent_scoring_history_mutation();
