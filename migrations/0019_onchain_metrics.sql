CREATE TABLE onchain_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN (
    'NETWORK', 'ADDRESS', 'MONETARY', 'RESOURCE',
    'GOVERNANCE', 'HOLDER', 'TRANSACTION', 'CONTRACT',
    'TOKEN', 'STABLECOIN', 'DEFI', 'EXCHANGE_FLOW',
    'VALIDATOR', 'WHALE', 'DEVELOPER', 'ECOSYSTEM'
  )),
  metric_name text NOT NULL CHECK (char_length(metric_name) BETWEEN 1 AND 200),
  blockchain text NOT NULL CHECK (char_length(blockchain) BETWEEN 1 AND 50),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 100),
  value_num double precision,
  value_text text CHECK (value_text IS NULL OR char_length(value_text) <= 1000),
  unit text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 50),
  timestamp timestamptz NOT NULL,
  block_height bigint,
  confidence text NOT NULL DEFAULT 'DIRECT' CHECK (confidence IN ('DIRECT', 'DERIVED', 'ESTIMATED')),
  address text CHECK (address IS NULL OR char_length(address) BETWEEN 1 AND 100),
  raw_data jsonb,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (value_num IS NOT NULL OR value_text IS NOT NULL)
);

CREATE INDEX idx_onchain_metrics_blockchain_name
  ON onchain_metrics (blockchain, metric_name, timestamp DESC);

CREATE INDEX idx_onchain_metrics_category
  ON onchain_metrics (category, blockchain, timestamp DESC);

CREATE INDEX idx_onchain_metrics_address
  ON onchain_metrics (address, blockchain, timestamp DESC)
  WHERE address IS NOT NULL;

CREATE INDEX idx_onchain_metrics_timestamp
  ON onchain_metrics (blockchain, timestamp DESC);
