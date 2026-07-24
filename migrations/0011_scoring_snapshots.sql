ALTER TABLE sources
  ADD COLUMN moderation_status text NOT NULL DEFAULT 'PENDING'
  CHECK (moderation_status IN ('PENDING', 'ACCEPTED', 'REJECTED'));

ALTER TABLE score_policies
  ADD COLUMN definition_hash char(64);

CREATE TABLE score_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  dimensions jsonb NOT NULL CHECK (jsonb_typeof(dimensions) = 'object'),
  eligible boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE scores
  DROP CONSTRAINT scores_proposal_id_dimension_policy_id_key;

ALTER TABLE scores
  ADD COLUMN score_run_id uuid REFERENCES score_runs(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX scores_run_dimension_unique
  ON scores (score_run_id, dimension)
  WHERE score_run_id IS NOT NULL;

CREATE INDEX score_runs_proposal_created_idx
  ON score_runs (proposal_id, created_at DESC);
