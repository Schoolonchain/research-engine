CREATE TABLE blockchain_rate_limits (
  action varchar(40) NOT NULL,
  scope varchar(20) NOT NULL CHECK (scope IN ('ACTOR', 'GLOBAL')),
  key_hash char(64) NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  window_started_at timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  limit_snapshot integer NOT NULL CHECK (limit_snapshot > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (action, scope, key_hash, policy_version, window_started_at)
);
