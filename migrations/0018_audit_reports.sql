CREATE TABLE audit_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES blockchain_networks(id) ON DELETE RESTRICT,
  audit_type text NOT NULL CHECK (audit_type IN ('FULL', 'ACCOUNT', 'CONTRACT')),
  target_address text CHECK (
    target_address IS NULL OR char_length(target_address) BETWEEN 1 AND 100
  ),
  overall_risk text NOT NULL CHECK (overall_risk IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
  finding_count_critical integer NOT NULL DEFAULT 0 CHECK (finding_count_critical >= 0),
  finding_count_high integer NOT NULL DEFAULT 0 CHECK (finding_count_high >= 0),
  finding_count_medium integer NOT NULL DEFAULT 0 CHECK (finding_count_medium >= 0),
  finding_count_low integer NOT NULL DEFAULT 0 CHECK (finding_count_low >= 0),
  finding_count_info integer NOT NULL DEFAULT 0 CHECK (finding_count_info >= 0),
  sources_used text[] NOT NULL DEFAULT '{}',
  data_points_collected integer NOT NULL DEFAULT 0 CHECK (data_points_collected >= 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (completed_at >= started_at),
  CHECK (
    (audit_type IN ('ACCOUNT', 'CONTRACT') AND target_address IS NOT NULL)
    OR (audit_type = 'FULL')
  )
);

CREATE INDEX audit_reports_network_idx
  ON audit_reports (network_id, created_at DESC);

CREATE INDEX audit_reports_target_idx
  ON audit_reports (target_address, created_at DESC)
  WHERE target_address IS NOT NULL;

CREATE INDEX audit_reports_risk_idx
  ON audit_reports (overall_risk, created_at DESC);

CREATE TABLE audit_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES audit_reports(id) ON DELETE CASCADE,
  analyzer_name text NOT NULL CHECK (char_length(analyzer_name) BETWEEN 1 AND 100),
  module text NOT NULL CHECK (module IN (
    'FUNDAMENTAL', 'ON_CHAIN', 'CARTERA', 'RIESGO',
    'OSINT', 'GOBERNANZA', 'DESARROLLO', 'INFRA',
    'MERCADO', 'AUTOMATIZACION'
  )),
  severity text NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 200),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 10000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  recommendation text CHECK (recommendation IS NULL OR char_length(recommendation) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_findings_report_idx
  ON audit_findings (report_id);

CREATE INDEX audit_findings_severity_idx
  ON audit_findings (report_id, severity);

CREATE INDEX audit_findings_category_idx
  ON audit_findings (category);
