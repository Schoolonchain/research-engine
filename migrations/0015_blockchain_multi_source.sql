-- This migration restructures the blockchain schema to support multiple data
-- sources per network. It assumes blockchain tables from 0014 are empty (no
-- deployed instance exists yet). A deployment with existing data would require
-- a backfill step before adding the NOT NULL constraint.

CREATE TABLE blockchain_data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES blockchain_networks(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('API', 'NODE', 'EXPLORER')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  endpoint text NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 2048),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'INACTIVE', 'DEPRECATED')),
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (network_id, name)
);

-- The network represents the chain itself, not an endpoint. Move endpoint
-- concerns to blockchain_data_sources.
ALTER TABLE blockchain_networks DROP COLUMN rpc_endpoint;

-- Each block observation is tied to the data source that produced it.
-- Two sources can independently observe and store the same block.
ALTER TABLE blockchain_blocks
  ADD COLUMN data_source_id uuid NOT NULL
    REFERENCES blockchain_data_sources(id) ON DELETE RESTRICT;

ALTER TABLE blockchain_blocks
  DROP CONSTRAINT blockchain_blocks_network_id_block_number_key;

ALTER TABLE blockchain_blocks
  ADD CONSTRAINT blockchain_blocks_network_source_block_unique
    UNIQUE (network_id, block_number, data_source_id);

-- Same for transactions: each observation belongs to a specific data source.
ALTER TABLE blockchain_transactions
  ADD COLUMN data_source_id uuid NOT NULL
    REFERENCES blockchain_data_sources(id) ON DELETE RESTRICT;

ALTER TABLE blockchain_transactions
  DROP CONSTRAINT blockchain_transactions_network_id_tx_hash_key;

ALTER TABLE blockchain_transactions
  ADD CONSTRAINT blockchain_transactions_network_source_tx_unique
    UNIQUE (network_id, tx_hash, data_source_id);

CREATE INDEX blockchain_data_sources_network_idx
  ON blockchain_data_sources (network_id, status);

CREATE INDEX blockchain_blocks_source_idx
  ON blockchain_blocks (data_source_id, block_number DESC);

CREATE INDEX blockchain_transactions_source_idx
  ON blockchain_transactions (data_source_id);
