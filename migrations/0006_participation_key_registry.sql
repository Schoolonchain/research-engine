CREATE TABLE participation_key_registry (
  key_id varchar(100) PRIMARY KEY,
  key_verifier char(64) NOT NULL,
  active_support_count bigint NOT NULL DEFAULT 0
    CHECK (active_support_count >= 0),
  registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION maintain_participation_key_usage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'ACTIVE' THEN
    UPDATE participation_key_registry
    SET active_support_count = active_support_count - 1
    WHERE key_id = OLD.subject_key_id AND active_support_count > 0;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'ACTIVE' THEN
    UPDATE participation_key_registry
    SET active_support_count = active_support_count + 1
    WHERE key_id = NEW.subject_key_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unregistered participation key ID: %', NEW.subject_key_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER supports_key_usage
AFTER INSERT OR UPDATE OF status, subject_key_id OR DELETE ON supports
FOR EACH ROW
EXECUTE FUNCTION maintain_participation_key_usage();
