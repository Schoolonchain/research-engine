ALTER TABLE authorizations
  ADD COLUMN eligibility_score_run_id uuid REFERENCES score_runs(id) ON DELETE RESTRICT,
  ADD COLUMN policy_set_hash char(64),
  ADD COLUMN revocation_reason text CHECK (
    revocation_reason IS NULL OR char_length(revocation_reason) BETWEEN 1 AND 2000
  ),
  ADD COLUMN admin_justification text CHECK (
    admin_justification IS NULL OR char_length(admin_justification) BETWEEN 1 AND 2000
  ),
  ADD CONSTRAINT authorizations_phase8_no_payment CHECK (type <> 'PAYMENT'),
  ADD CONSTRAINT authorizations_snapshot_complete CHECK (
    policy_set_hash IS NOT NULL
    AND (type = 'ADMIN' OR eligibility_score_run_id IS NOT NULL)
    AND (type <> 'ADMIN' OR admin_justification IS NOT NULL)
  );

ALTER TABLE research_jobs
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN execution_output jsonb CHECK (
    execution_output IS NULL OR jsonb_typeof(execution_output) = 'object'
  );

CREATE TABLE research_job_attempt_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_job_id uuid NOT NULL REFERENCES research_jobs(id) ON DELETE RESTRICT,
  attempt integer NOT NULL CHECK (attempt > 0),
  calls_used integer NOT NULL CHECK (calls_used >= 0),
  tokens_used bigint NOT NULL CHECK (tokens_used >= 0),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  outcome text NOT NULL CHECK (outcome IN ('COMPLETED', 'FAILED', 'CANCELLED')),
  error_code varchar(100),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (research_job_id, attempt)
);

CREATE TRIGGER research_job_attempt_usage_append_only
BEFORE UPDATE OR DELETE ON research_job_attempt_usage
FOR EACH ROW EXECUTE FUNCTION prevent_scoring_history_mutation();

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
