ALTER TABLE score_policies
  ADD COLUMN eligibility_definition jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(eligibility_definition) = 'object');

CREATE UNIQUE INDEX score_policies_one_active_dimension
  ON score_policies (dimension)
  WHERE status = 'ACTIVE';
