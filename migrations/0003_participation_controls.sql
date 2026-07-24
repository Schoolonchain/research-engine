CREATE TABLE participation_rate_limits (
  action varchar(100) NOT NULL,
  scope varchar(30) NOT NULL
    CHECK (scope IN ('SUBJECT', 'NETWORK', 'GLOBAL')),
  key_hash char(64) NOT NULL,
  window_started_at timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  limit_snapshot integer NOT NULL CHECK (limit_snapshot > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (action, scope, key_hash, window_started_at),
  CHECK (action ~ '^[a-z][a-z0-9_]{0,99}$'),
  CHECK (expires_at > window_started_at)
);

CREATE INDEX participation_rate_limits_expiry_idx
  ON participation_rate_limits (expires_at);

CREATE TABLE abuse_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action varchar(100) NOT NULL,
  scope varchar(30) NOT NULL
    CHECK (scope IN ('SUBJECT', 'NETWORK', 'GLOBAL')),
  key_hash char(64) NOT NULL,
  signal_type varchar(100) NOT NULL,
  risk_level varchar(20) NOT NULL
    CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  observed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  CHECK (action ~ '^[a-z][a-z0-9_]{0,99}$'),
  CHECK (signal_type ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  CHECK (expires_at > observed_at)
);

CREATE INDEX abuse_signals_expiry_idx ON abuse_signals (expires_at);
CREATE INDEX abuse_signals_lookup_idx
  ON abuse_signals (scope, key_hash, observed_at DESC);

CREATE INDEX supports_subject_history_idx
  ON supports (proposal_id, subject_key_hash, created_at DESC);

