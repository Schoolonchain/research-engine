ALTER TABLE score_policies
  ALTER COLUMN definition_hash SET NOT NULL;

ALTER TABLE scores
  ALTER COLUMN score_run_id SET NOT NULL;

CREATE TABLE score_policy_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  previous_policy_version integer,
  correlation_id uuid NOT NULL UNIQUE,
  activated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION prevent_scoring_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER score_runs_append_only
BEFORE UPDATE OR DELETE ON score_runs
FOR EACH ROW EXECUTE FUNCTION prevent_scoring_history_mutation();

CREATE TRIGGER scores_history_append_only
BEFORE UPDATE OR DELETE ON scores
FOR EACH ROW EXECUTE FUNCTION prevent_scoring_history_mutation();

CREATE FUNCTION protect_score_policy_definition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.dimension IS DISTINCT FROM OLD.dimension
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.definition IS DISTINCT FROM OLD.definition
    OR NEW.eligibility_definition IS DISTINCT FROM OLD.eligibility_definition
    OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash THEN
    RAISE EXCEPTION 'score policy definition is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER score_policy_definition_immutable
BEFORE UPDATE ON score_policies
FOR EACH ROW EXECUTE FUNCTION protect_score_policy_definition();
