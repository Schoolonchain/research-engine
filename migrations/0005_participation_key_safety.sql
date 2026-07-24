ALTER TABLE participation_subject_locks
  ADD COLUMN expires_at timestamptz NOT NULL
  DEFAULT (CURRENT_TIMESTAMP + interval '24 hours');

CREATE INDEX participation_subject_locks_expiry_idx
  ON participation_subject_locks (expires_at);

CREATE TABLE participation_identity_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_id uuid NOT NULL REFERENCES supports(id) ON DELETE CASCADE,
  from_key_id varchar(100) NOT NULL,
  to_key_id varchar(100) NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (from_key_id <> to_key_id)
);

CREATE INDEX participation_identity_migrations_support_idx
  ON participation_identity_migrations (support_id, migrated_at);
