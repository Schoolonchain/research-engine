CREATE TABLE aggregate_streams (
  aggregate_type varchar(100) NOT NULL,
  aggregate_id uuid NOT NULL,
  current_sequence bigint NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (aggregate_type, aggregate_id),
  CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{0,99}$')
);

CREATE TABLE domain_events (
  event_id uuid PRIMARY KEY,
  aggregate_type varchar(100) NOT NULL,
  aggregate_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type varchar(150) NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  actor_type varchar(50),
  actor_id uuid,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (aggregate_type, aggregate_id, sequence),
  CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{0,99}$'),
  CHECK (event_type ~ '^[a-z][a-z0-9_]{0,149}$'),
  CHECK (actor_type IS NULL OR actor_type ~ '^[a-z][a-z0-9_]{0,49}$'),
  CHECK (
    (actor_type IS NULL AND actor_id IS NULL)
    OR actor_type IS NOT NULL
  ),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 65536)
);

CREATE INDEX domain_events_aggregate_idx
  ON domain_events (aggregate_type, aggregate_id, sequence);

CREATE INDEX domain_events_correlation_idx
  ON domain_events (correlation_id, recorded_at);

CREATE INDEX domain_events_type_recorded_idx
  ON domain_events (event_type, recorded_at);

CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES domain_events(event_id) ON DELETE RESTRICT,
  topic varchar(150) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner varchar(200),
  lease_expires_at timestamptz,
  published_at timestamptz,
  last_error_code varchar(200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (topic ~ '^[a-z][a-z0-9_.-]{0,149}$'),
  CHECK (
    (status = 'PROCESSING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'PROCESSING'
  ),
  CHECK (
    (status = 'PUBLISHED' AND published_at IS NOT NULL)
    OR status <> 'PUBLISHED'
  )
);

CREATE INDEX outbox_messages_dispatch_idx
  ON outbox_messages (status, available_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE consumer_receipts (
  consumer_name varchar(150) NOT NULL,
  event_id uuid NOT NULL REFERENCES domain_events(event_id) ON DELETE RESTRICT,
  processed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (consumer_name, event_id),
  CHECK (consumer_name ~ '^[a-z][a-z0-9_.-]{0,149}$')
);

CREATE TABLE aggregate_event_counts (
  consumer_name varchar(150) NOT NULL,
  aggregate_type varchar(100) NOT NULL,
  aggregate_id uuid NOT NULL,
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (consumer_name, aggregate_type, aggregate_id)
);

CREATE OR REPLACE FUNCTION reject_domain_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'domain_events is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER domain_events_reject_update
BEFORE UPDATE ON domain_events
FOR EACH ROW
EXECUTE FUNCTION reject_domain_event_mutation();

CREATE TRIGGER domain_events_reject_delete
BEFORE DELETE ON domain_events
FOR EACH ROW
EXECUTE FUNCTION reject_domain_event_mutation();

