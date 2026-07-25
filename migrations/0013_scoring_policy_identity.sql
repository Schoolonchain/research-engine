ALTER TABLE score_policy_activations
  ADD COLUMN policy_set_hash char(64) NOT NULL;

CREATE TRIGGER score_policy_activations_append_only
BEFORE UPDATE OR DELETE ON score_policy_activations
FOR EACH ROW EXECUTE FUNCTION prevent_scoring_history_mutation();

CREATE TRIGGER score_policies_no_delete
BEFORE DELETE ON score_policies
FOR EACH ROW EXECUTE FUNCTION prevent_scoring_history_mutation();
