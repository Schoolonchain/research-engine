CREATE INDEX knowledge_rate_limits_expiry_idx
  ON knowledge_rate_limits (expires_at);

CREATE FUNCTION prevent_knowledge_proposal_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id THEN
    RAISE EXCEPTION 'knowledge entity proposal_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sources_proposal_immutable
BEFORE UPDATE OF proposal_id ON sources
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_proposal_move();

CREATE TRIGGER claims_proposal_immutable
BEFORE UPDATE OF proposal_id ON claims
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_proposal_move();
