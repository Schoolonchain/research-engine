ALTER TABLE supports
  ADD COLUMN subject_key_id varchar(100) NOT NULL DEFAULT 'legacy-v1';

ALTER TABLE supports
  ADD CONSTRAINT supports_subject_key_id_format
  CHECK (subject_key_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$');

CREATE TABLE participation_subject_locks (
  key_hash char(64) PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE participation_rate_limits
  ADD COLUMN policy_version integer NOT NULL DEFAULT 1
  CHECK (policy_version > 0);

ALTER TABLE participation_rate_limits
  DROP CONSTRAINT participation_rate_limits_pkey;

ALTER TABLE participation_rate_limits
  ADD PRIMARY KEY (
    action,
    scope,
    key_hash,
    policy_version,
    window_started_at
  );

