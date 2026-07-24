CREATE TABLE actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('ANONYMOUS', 'USER', 'ADMIN', 'SYSTEM')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  author_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  central_question text NOT NULL
    CHECK (char_length(central_question) BETWEEN 1 AND 2000),
  description text NOT NULL DEFAULT ''
    CHECK (char_length(description) <= 20000),
  status text NOT NULL DEFAULT 'CREATED'
    CHECK (status IN (
      'CREATED', 'OPEN', 'COLLECTING', 'THRESHOLD_REACHED', 'ELIGIBLE',
      'AUTHORIZED', 'ARCHIVED', 'REJECTED', 'DELETION_PENDING', 'DELETED'
    )),
  visibility text NOT NULL DEFAULT 'PUBLIC'
    CHECK (visibility IN ('PUBLIC', 'UNLISTED', 'PRIVATE')),
  status_reason text CHECK (
    status_reason IS NULL OR char_length(status_reason) <= 2000
  ),
  support_count bigint NOT NULL DEFAULT 0 CHECK (support_count >= 0),
  priority_score numeric(12, 6),
  priority_score_policy_version integer,
  opened_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (status = 'DELETED' AND deleted_at IS NOT NULL)
    OR status <> 'DELETED'
  )
);

CREATE INDEX proposals_status_created_idx
  ON proposals (status, created_at DESC);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  contributed_by_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('URL', 'DOCUMENT', 'CONTEXT')),
  original_url text CHECK (
    original_url IS NULL OR char_length(original_url) <= 4096
  ),
  canonical_url text CHECK (
    canonical_url IS NULL OR char_length(canonical_url) <= 4096
  ),
  title text CHECK (title IS NULL OR char_length(title) <= 1000),
  publisher text CHECK (publisher IS NULL OR char_length(publisher) <= 500),
  language_code varchar(35),
  published_at timestamptz,
  content_sha256 char(64),
  fetch_status text NOT NULL DEFAULT 'NOT_REQUESTED'
    CHECK (fetch_status IN (
      'NOT_REQUESTED', 'PENDING', 'FETCHED', 'REJECTED', 'FAILED'
    )),
  quality_status text NOT NULL DEFAULT 'UNASSESSED'
    CHECK (quality_status IN (
      'UNASSESSED', 'LOW', 'MEDIUM', 'HIGH', 'REJECTED'
    )),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (kind = 'URL' AND original_url IS NOT NULL)
    OR kind <> 'URL'
  )
);

CREATE UNIQUE INDEX sources_proposal_canonical_url_unique
  ON sources (proposal_id, canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE INDEX sources_proposal_created_idx
  ON sources (proposal_id, created_at DESC);

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  created_by_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 10000),
  classification text NOT NULL DEFAULT 'CLAIM'
    CHECK (classification IN ('FACT', 'CLAIM', 'INFERENCE', 'UNCERTAINTY')),
  context text CHECK (context IS NULL OR char_length(context) <= 20000),
  moderation_status text NOT NULL DEFAULT 'PENDING'
    CHECK (moderation_status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX claims_proposal_created_idx
  ON claims (proposal_id, created_at DESC);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  contributed_by_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  stance text NOT NULL CHECK (
    stance IN ('SUPPORTS', 'CONTRADICTS', 'CONTEXTUALIZES', 'UNKNOWN')
  ),
  locator text CHECK (locator IS NULL OR char_length(locator) <= 2000),
  excerpt text CHECK (excerpt IS NULL OR char_length(excerpt) <= 20000),
  context text CHECK (context IS NULL OR char_length(context) <= 20000),
  quality_status text NOT NULL DEFAULT 'UNASSESSED'
    CHECK (quality_status IN (
      'UNASSESSED', 'LOW', 'MEDIUM', 'HIGH', 'REJECTED'
    )),
  moderation_status text NOT NULL DEFAULT 'PENDING'
    CHECK (moderation_status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (claim_id, source_id, stance, locator)
);

CREATE INDEX evidence_claim_idx ON evidence (claim_id);
CREATE INDEX evidence_source_idx ON evidence (source_id);

CREATE TABLE supports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  subject_key_hash char(64) NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
    OR status <> 'REVOKED'
  )
);

CREATE UNIQUE INDEX supports_active_subject_unique
  ON supports (proposal_id, subject_key_hash)
  WHERE status = 'ACTIVE';

CREATE INDEX supports_proposal_created_idx
  ON supports (proposal_id, created_at DESC);

CREATE TABLE score_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension text NOT NULL CHECK (
    dimension IN ('PRIORITY', 'PROGRESS', 'CONFIDENCE', 'SUPPORT_COUNT')
  ),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at timestamptz,
  UNIQUE (dimension, version)
);

CREATE TABLE scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES score_policies(id) ON DELETE RESTRICT,
  dimension text NOT NULL CHECK (
    dimension IN ('PRIORITY', 'PROGRESS', 'CONFIDENCE', 'SUPPORT_COUNT')
  ),
  value numeric(18, 6) NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(inputs) = 'object'),
  explanation text NOT NULL DEFAULT ''
    CHECK (char_length(explanation) <= 10000),
  calculated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (proposal_id, dimension, policy_id)
);

CREATE INDEX scores_proposal_dimension_idx
  ON scores (proposal_id, dimension, calculated_at DESC);

CREATE TABLE authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  issued_by_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('ADMIN', 'PAYMENT', 'THRESHOLD')),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING', 'VALID', 'CONSUMED', 'REVOKED', 'EXPIRED', 'REJECTED'
    )),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  idempotency_key varchar(200) NOT NULL UNIQUE,
  max_cost_minor bigint NOT NULL CHECK (max_cost_minor >= 0),
  currency char(3) NOT NULL,
  max_duration_seconds integer NOT NULL CHECK (max_duration_seconds > 0),
  max_calls integer NOT NULL CHECK (max_calls > 0),
  max_tokens bigint NOT NULL CHECK (max_tokens > 0),
  valid_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (expires_at > valid_from),
  CHECK (
    (status = 'CONSUMED' AND consumed_at IS NOT NULL)
    OR status <> 'CONSUMED'
  ),
  CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
    OR status <> 'REVOKED'
  )
);

CREATE INDEX authorizations_proposal_status_idx
  ON authorizations (proposal_id, status, expires_at);

CREATE TABLE research_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  authorization_id uuid NOT NULL UNIQUE
    REFERENCES authorizations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'CREATED'
    CHECK (status IN (
      'CREATED', 'QUEUED', 'RUNNING', 'PAUSED',
      'COMPLETED', 'FAILED', 'CANCELLED'
    )),
  plan_version integer NOT NULL CHECK (plan_version > 0),
  priority integer NOT NULL DEFAULT 0,
  max_cost_minor bigint NOT NULL CHECK (max_cost_minor >= 0),
  currency char(3) NOT NULL,
  max_duration_seconds integer NOT NULL CHECK (max_duration_seconds > 0),
  max_calls integer NOT NULL CHECK (max_calls > 0),
  max_tokens bigint NOT NULL CHECK (max_tokens > 0),
  spent_cost_minor bigint NOT NULL DEFAULT 0 CHECK (spent_cost_minor >= 0),
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  stop_condition jsonb NOT NULL CHECK (jsonb_typeof(stop_condition) = 'object'),
  lease_owner text,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  error_code varchar(200),
  error_detail text CHECK (
    error_detail IS NULL OR char_length(error_detail) <= 20000
  ),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (spent_cost_minor <= max_cost_minor),
  CHECK (calls_used <= max_calls),
  CHECK (tokens_used <= max_tokens),
  CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR status <> 'COMPLETED'
  ),
  CHECK (
    (status = 'FAILED' AND failed_at IS NOT NULL)
    OR status <> 'FAILED'
  ),
  CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    OR status <> 'CANCELLED'
  )
);

CREATE INDEX research_jobs_status_created_idx
  ON research_jobs (status, priority DESC, created_at);

CREATE TABLE research_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  research_job_id uuid NOT NULL REFERENCES research_jobs(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT', 'SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED',
      'VALIDATED', 'PUBLISHED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN'
    )),
  summary text NOT NULL DEFAULT ''
    CHECK (char_length(summary) <= 50000),
  facts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(facts) = 'array'),
  claims jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(claims) = 'array'),
  inferences jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(inferences) = 'array'),
  uncertainties jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(uncertainties) = 'array'),
  conflicting_evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(conflicting_evidence) = 'array'),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(citations) = 'array'),
  limitations text NOT NULL DEFAULT ''
    CHECK (char_length(limitations) <= 50000),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metrics) = 'object'),
  submitted_at timestamptz,
  validated_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (research_job_id, version),
  CHECK (
    (status = 'VALIDATED' AND validated_at IS NOT NULL)
    OR status <> 'VALIDATED'
  ),
  CHECK (
    (status = 'PUBLISHED' AND published_at IS NOT NULL)
    OR status <> 'PUBLISHED'
  )
);

CREATE INDEX research_results_job_status_idx
  ON research_results (research_job_id, status, version DESC);

