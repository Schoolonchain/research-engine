-- M-02: Persistent snapshot storage for cross-run risk comparison.
-- The risk detector compares current vs previous snapshots to detect
-- massive unstaking, SR rotation, silent accumulation, etc.
-- Without persistence, `previous` is always null and those checks are skipped.

CREATE TABLE IF NOT EXISTS wallet_audit_snapshots (
  id text PRIMARY KEY,
  network_summary jsonb NOT NULL,
  power_index_summary jsonb NOT NULL,
  wallet_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_created_at
  ON wallet_audit_snapshots (created_at DESC);

-- Store individual wallet scores per snapshot for diff comparisons.
CREATE TABLE IF NOT EXISTS snapshot_wallet_scores (
  snapshot_id text NOT NULL REFERENCES wallet_audit_snapshots(id) ON DELETE CASCADE,
  address text NOT NULL,
  balance numeric NOT NULL DEFAULT 0,
  voting_power numeric NOT NULL DEFAULT 0,
  delegated_to_count integer NOT NULL DEFAULT 0,
  energy_limit numeric NOT NULL DEFAULT 0,
  power_score numeric NOT NULL DEFAULT 0,
  roles jsonb,
  raw_score_data jsonb,
  PRIMARY KEY (snapshot_id, address)
);
