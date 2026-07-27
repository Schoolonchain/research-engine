CREATE TABLE blockchain_networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 100),
  chain_id text NOT NULL UNIQUE CHECK (char_length(chain_id) BETWEEN 1 AND 100),
  network_type text NOT NULL CHECK (network_type IN ('MAINNET', 'TESTNET')),
  rpc_endpoint text NOT NULL CHECK (char_length(rpc_endpoint) BETWEEN 1 AND 2048),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'INACTIVE', 'DEPRECATED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE blockchain_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES blockchain_networks(id) ON DELETE RESTRICT,
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (char_length(block_hash) BETWEEN 1 AND 128),
  parent_hash text NOT NULL CHECK (char_length(parent_hash) BETWEEN 1 AND 128),
  block_timestamp timestamptz NOT NULL,
  witness_address text CHECK (witness_address IS NULL OR char_length(witness_address) <= 100),
  tx_count integer NOT NULL CHECK (tx_count >= 0),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  raw_data jsonb NOT NULL CHECK (jsonb_typeof(raw_data) = 'object'),
  collection_source text NOT NULL CHECK (char_length(collection_source) BETWEEN 1 AND 200),
  collected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (network_id, block_number)
);

CREATE INDEX blockchain_blocks_number_idx
  ON blockchain_blocks (network_id, block_number DESC);

CREATE INDEX blockchain_blocks_timestamp_idx
  ON blockchain_blocks (network_id, block_timestamp DESC);

CREATE TABLE blockchain_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES blockchain_networks(id) ON DELETE RESTRICT,
  block_id uuid NOT NULL REFERENCES blockchain_blocks(id) ON DELETE CASCADE,
  tx_hash text NOT NULL CHECK (char_length(tx_hash) BETWEEN 1 AND 128),
  tx_type text NOT NULL CHECK (char_length(tx_type) BETWEEN 1 AND 100),
  from_address text CHECK (from_address IS NULL OR char_length(from_address) <= 100),
  to_address text CHECK (to_address IS NULL OR char_length(to_address) <= 100),
  amount_sun bigint CHECK (amount_sun IS NULL OR amount_sun >= 0),
  result text CHECK (result IS NULL OR char_length(result) <= 100),
  fee_sun bigint CHECK (fee_sun IS NULL OR fee_sun >= 0),
  energy_used bigint CHECK (energy_used IS NULL OR energy_used >= 0),
  bandwidth_used bigint CHECK (bandwidth_used IS NULL OR bandwidth_used >= 0),
  raw_data jsonb NOT NULL CHECK (jsonb_typeof(raw_data) = 'object'),
  collected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (network_id, tx_hash)
);

CREATE INDEX blockchain_transactions_block_idx
  ON blockchain_transactions (block_id);

CREATE INDEX blockchain_transactions_from_idx
  ON blockchain_transactions (network_id, from_address)
  WHERE from_address IS NOT NULL;

CREATE INDEX blockchain_transactions_to_idx
  ON blockchain_transactions (network_id, to_address)
  WHERE to_address IS NOT NULL;

CREATE TABLE data_collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES blockchain_networks(id) ON DELETE RESTRICT,
  run_type text NOT NULL CHECK (run_type IN ('BLOCK', 'RANGE', 'ACCOUNT', 'CONTRACT')),
  status text NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL')),
  source_api text NOT NULL CHECK (char_length(source_api) BETWEEN 1 AND 200),
  block_start bigint CHECK (block_start IS NULL OR block_start >= 0),
  block_end bigint CHECK (block_end IS NULL OR block_end >= 0),
  blocks_collected integer NOT NULL DEFAULT 0 CHECK (blocks_collected >= 0),
  txs_collected integer NOT NULL DEFAULT 0 CHECK (txs_collected >= 0),
  error_detail text CHECK (error_detail IS NULL OR char_length(error_detail) <= 10000),
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  CHECK (
    (status IN ('COMPLETED', 'FAILED', 'PARTIAL') AND completed_at IS NOT NULL)
    OR status = 'RUNNING'
  ),
  CHECK (block_end IS NULL OR block_start IS NULL OR block_end >= block_start)
);

CREATE INDEX data_collection_runs_network_idx
  ON data_collection_runs (network_id, started_at DESC);
