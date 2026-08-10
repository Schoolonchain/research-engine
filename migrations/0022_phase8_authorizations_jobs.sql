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

ALTER TABLE authorizations
  DROP CONSTRAINT authorizations_idempotency_key_key,
  ADD CONSTRAINT authorizations_actor_idempotency_unique
    UNIQUE (issued_by_actor_id, idempotency_key);

ALTER TABLE research_jobs
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN lease_token uuid,
  ADD COLUMN execution_output jsonb CHECK (
    execution_output IS NULL OR jsonb_typeof(execution_output) = 'object'
  );

ALTER TABLE research_jobs
  ADD CONSTRAINT research_jobs_lease_bounded_by_deadline CHECK (
    lease_expires_at IS NULL OR (lease_token IS NOT NULL AND lease_expires_at <= deadline_at)
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

CREATE FUNCTION protect_phase8_authorization() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authorization history is immutable';
  END IF;
  IF NEW.proposal_id <> OLD.proposal_id
    OR NEW.issued_by_actor_id IS DISTINCT FROM OLD.issued_by_actor_id
    OR NEW.type <> OLD.type OR NEW.policy_version <> OLD.policy_version
    OR NEW.evidence <> OLD.evidence OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.max_cost_minor <> OLD.max_cost_minor OR NEW.currency <> OLD.currency
    OR NEW.max_duration_seconds <> OLD.max_duration_seconds
    OR NEW.max_calls <> OLD.max_calls OR NEW.max_tokens <> OLD.max_tokens
    OR NEW.valid_from <> OLD.valid_from OR NEW.expires_at <> OLD.expires_at
    OR NEW.eligibility_score_run_id IS DISTINCT FROM OLD.eligibility_score_run_id
    OR NEW.policy_set_hash <> OLD.policy_set_hash
    OR NEW.admin_justification IS DISTINCT FROM OLD.admin_justification THEN
    RAISE EXCEPTION 'authorization grant is immutable';
  END IF;
  IF OLD.status = 'VALID' AND NEW.status NOT IN ('VALID','CONSUMED','REVOKED','EXPIRED') THEN
    RAISE EXCEPTION 'invalid authorization transition';
  END IF;
  IF OLD.status IN ('CONSUMED','REVOKED','EXPIRED','REJECTED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'terminal authorization is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorizations_phase8_integrity
BEFORE UPDATE OR DELETE ON authorizations
FOR EACH ROW EXECUTE FUNCTION protect_phase8_authorization();

CREATE FUNCTION protect_phase8_research_job() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'research job history is immutable'; END IF;
  IF NEW.proposal_id <> OLD.proposal_id OR NEW.authorization_id <> OLD.authorization_id
    OR NEW.plan_version <> OLD.plan_version OR NEW.max_cost_minor <> OLD.max_cost_minor
    OR NEW.currency <> OLD.currency OR NEW.max_duration_seconds <> OLD.max_duration_seconds
    OR NEW.max_calls <> OLD.max_calls OR NEW.max_tokens <> OLD.max_tokens
    OR NEW.max_attempts <> OLD.max_attempts OR NEW.deadline_at <> OLD.deadline_at THEN
    RAISE EXCEPTION 'research job grant is immutable';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.calls_used < OLD.calls_used
    OR NEW.tokens_used < OLD.tokens_used OR NEW.spent_cost_minor < OLD.spent_cost_minor THEN
    RAISE EXCEPTION 'research job counters cannot decrease';
  END IF;
  IF NEW.attempts <> OLD.attempts AND (
      NEW.attempts <> OLD.attempts + 1 OR NEW.status <> 'RUNNING'
      OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token) THEN
    RAISE EXCEPTION 'attempt increment requires a fresh lease generation';
  END IF;
  IF NEW.lease_token IS DISTINCT FROM OLD.lease_token
    AND NOT (NEW.attempts = OLD.attempts + 1 AND NEW.status = 'RUNNING')
    AND NEW.lease_token IS NOT NULL THEN
    RAISE EXCEPTION 'lease generation cannot be replaced outside claim';
  END IF;
  IF OLD.status IN ('COMPLETED','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'terminal research job is immutable';
  END IF;
  IF (OLD.status = 'QUEUED' AND NEW.status NOT IN ('QUEUED','RUNNING','FAILED','CANCELLED'))
    OR (OLD.status = 'RUNNING' AND NEW.status NOT IN ('RUNNING','QUEUED','COMPLETED','FAILED','CANCELLED'))
    OR (OLD.status = 'PAUSED' AND NEW.status NOT IN ('PAUSED','QUEUED','CANCELLED')) THEN
    RAISE EXCEPTION 'invalid research job transition';
  END IF;
  IF NEW.status = 'RUNNING' AND (NEW.lease_owner IS NULL OR NEW.lease_token IS NULL
      OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at > NEW.deadline_at) THEN
    RAISE EXCEPTION 'running job requires a bounded lease generation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER research_jobs_phase8_integrity
BEFORE UPDATE OR DELETE ON research_jobs
FOR EACH ROW EXECUTE FUNCTION protect_phase8_research_job();
