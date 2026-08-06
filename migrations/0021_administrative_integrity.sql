ALTER TABLE proposals
  ADD COLUMN knowledge_revision bigint NOT NULL DEFAULT 0 CHECK (knowledge_revision >= 0),
  ADD COLUMN eligibility_score_run_id uuid REFERENCES score_runs(id) ON DELETE RESTRICT,
  ADD COLUMN eligibility_policy_set_hash char(64),
  ADD COLUMN eligibility_knowledge_revision bigint CHECK (eligibility_knowledge_revision >= 0),
  ADD CONSTRAINT proposals_eligibility_snapshot_complete CHECK (
    (eligibility_score_run_id IS NULL
      AND eligibility_policy_set_hash IS NULL
      AND eligibility_knowledge_revision IS NULL)
    OR
    (eligibility_score_run_id IS NOT NULL
      AND eligibility_policy_set_hash IS NOT NULL
      AND eligibility_knowledge_revision IS NOT NULL)
  );

-- Existing ELIGIBLE rows deliberately retain their state but receive NULL snapshot
-- references. Consumers therefore exclude them fail-closed until bounded, resumable
-- per-Proposal rescoring populates the snapshot under the active global policy hash.

ALTER TABLE score_runs
  ADD COLUMN policy_set_hash char(64),
  ADD COLUMN knowledge_revision bigint CHECK (knowledge_revision >= 0);

ALTER TABLE score_policy_activations
  ADD COLUMN activation_sequence bigserial UNIQUE;

ALTER TABLE administrative_action_audit
  ADD COLUMN reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000);

ALTER TABLE administrative_action_audit
  DROP CONSTRAINT administrative_action_audit_session_id_fkey;

CREATE TABLE administrative_mutation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES administrative_identities(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  correlation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (identity_id, operation, idempotency_key)
);

CREATE TRIGGER administrative_mutation_receipts_append_only
BEFORE UPDATE OR DELETE ON administrative_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_scoring_history_mutation();

CREATE TABLE administrative_locks (
  name text PRIMARY KEY CHECK (char_length(name) BETWEEN 1 AND 100)
);

INSERT INTO administrative_locks (name) VALUES ('policy_activation');

CREATE INDEX proposals_fresh_eligibility_idx
  ON proposals (updated_at, public_id)
  WHERE status = 'ELIGIBLE' AND eligibility_score_run_id IS NOT NULL;

CREATE VIEW current_proposal_eligibility AS
WITH active_activation AS (
  SELECT policy_version, policy_set_hash
  FROM score_policy_activations
  ORDER BY activation_sequence DESC
  LIMIT 1
)
SELECT proposal.id AS proposal_id,
  run.id AS score_run_id,
  run.policy_set_hash,
  proposal.knowledge_revision,
  run.created_at AS score_created_at
FROM proposals AS proposal
JOIN score_runs AS run ON run.id = proposal.eligibility_score_run_id
JOIN active_activation AS activation
  ON activation.policy_version = run.policy_version
 AND activation.policy_set_hash = run.policy_set_hash
WHERE proposal.status = 'ELIGIBLE'
  AND run.eligible = true
  AND run.knowledge_revision = proposal.knowledge_revision
  AND proposal.eligibility_knowledge_revision = proposal.knowledge_revision
  AND proposal.eligibility_policy_set_hash = run.policy_set_hash;
