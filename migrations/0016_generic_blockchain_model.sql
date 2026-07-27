-- Phase 1: Genericize the blockchain data model.
--
-- Removes TRON-specific columns (amount_sun, fee_sun, energy_used,
-- bandwidth_used) from blockchain_transactions and replaces them with
-- chain-agnostic columns (amount, fee, amount_unit, fee_unit) plus a
-- chain_data JSONB column for chain-specific attributes.
--
-- Renames witness_address → block_producer in blockchain_blocks (neutral
-- term that covers miners, validators, witnesses, and block producers).
--
-- Safe to run: blockchain tables contain no production data yet.

-- ── Blocks: rename witness_address → block_producer ──
ALTER TABLE blockchain_blocks
  RENAME COLUMN witness_address TO block_producer;

-- ── Transactions: add generic columns ──
ALTER TABLE blockchain_transactions
  ADD COLUMN amount text CHECK (amount IS NULL OR char_length(amount) <= 78),
  ADD COLUMN fee text CHECK (fee IS NULL OR char_length(fee) <= 78),
  ADD COLUMN amount_unit text CHECK (amount_unit IS NULL OR char_length(amount_unit) BETWEEN 1 AND 20),
  ADD COLUMN fee_unit text CHECK (fee_unit IS NULL OR char_length(fee_unit) BETWEEN 1 AND 20),
  ADD COLUMN chain_data jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── Transactions: drop TRON-specific columns ──
ALTER TABLE blockchain_transactions
  DROP COLUMN amount_sun,
  DROP COLUMN fee_sun,
  DROP COLUMN energy_used,
  DROP COLUMN bandwidth_used;
