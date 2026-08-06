ALTER TABLE authorizations
  ADD COLUMN eligibility_score_run_id uuid REFERENCES score_runs(id) ON DELETE RESTRICT,
  ADD COLUMN policy_set_hash char(64),
  ADD COLUMN revocation_reason text CHECK (
    revocation_reason IS NULL OR char_length(revocation_reason) BETWEEN 1 AND 2000
  ),
  ADD CONSTRAINT authorizations_phase8_no_payment CHECK (type <> 'PAYMENT'),
  ADD CONSTRAINT authorizations_snapshot_complete CHECK (
    (eligibility_score_run_id IS NULL AND policy_set_hash IS NULL)
    OR (eligibility_score_run_id IS NOT NULL AND policy_set_hash IS NOT NULL)
  );

ALTER TABLE research_jobs
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN execution_output jsonb CHECK (
    execution_output IS NULL OR jsonb_typeof(execution_output) = 'object'
  );

CREATE INDEX research_jobs_lease_queue_idx
  ON research_jobs (status, available_at, priority DESC, created_at)
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE TABLE research_mutation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES actors(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  correlation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_id, operation, idempotency_key)
);

CREATE TRIGGER research_mutation_receipts_append_only
BEFORE UPDATE OR DELETE ON research_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_scoring_history_mutation();
