ALTER TABLE sources ADD COLUMN idempotency_key varchar(200);
ALTER TABLE claims ADD COLUMN idempotency_key varchar(200);
ALTER TABLE evidence ADD COLUMN idempotency_key varchar(200);

CREATE UNIQUE INDEX sources_actor_idempotency_unique
  ON sources (contributed_by_actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX claims_actor_idempotency_unique
  ON claims (created_by_actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX evidence_actor_idempotency_unique
  ON evidence (contributed_by_actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE evidence
  DROP CONSTRAINT evidence_claim_id_source_id_stance_locator_key;
CREATE UNIQUE INDEX evidence_relation_unique
  ON evidence (claim_id, source_id, stance, locator) NULLS NOT DISTINCT;

CREATE FUNCTION enforce_knowledge_proposal_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  related_proposal_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'claims' AND NEW.source_id IS NOT NULL THEN
    SELECT proposal_id INTO related_proposal_id FROM sources WHERE id = NEW.source_id;
    IF related_proposal_id IS DISTINCT FROM NEW.proposal_id THEN
      RAISE EXCEPTION 'claim source must belong to the same proposal';
    END IF;
  ELSIF TG_TABLE_NAME = 'evidence' THEN
    SELECT claim.proposal_id INTO related_proposal_id
    FROM claims AS claim
    JOIN sources AS source ON source.id = NEW.source_id
    WHERE claim.id = NEW.claim_id AND source.proposal_id = claim.proposal_id;
    IF related_proposal_id IS NULL THEN
      RAISE EXCEPTION 'evidence claim and source must belong to the same proposal';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER claims_proposal_integrity
BEFORE INSERT OR UPDATE OF proposal_id, source_id ON claims
FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_proposal_integrity();
CREATE TRIGGER evidence_proposal_integrity
BEFORE INSERT OR UPDATE OF claim_id, source_id ON evidence
FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_proposal_integrity();

CREATE TABLE knowledge_rate_limits (
  action varchar(40) NOT NULL,
  scope varchar(20) NOT NULL CHECK (scope IN ('ACTOR', 'GLOBAL')),
  key_hash char(64) NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  window_started_at timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  limit_snapshot integer NOT NULL CHECK (limit_snapshot > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (action, scope, key_hash, policy_version, window_started_at)
);
