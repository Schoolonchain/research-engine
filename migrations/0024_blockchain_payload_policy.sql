-- C-6: Add payload integrity columns to blockchain_blocks and blockchain_transactions.
--
-- raw_data_bytes:    actual UTF-8 byte length of the raw_data JSON, computed via
--                    Buffer.byteLength(json, "utf8") before insertion (C-1).
-- raw_data_checksum: SHA-256 hex digest of the raw_data JSON, computed before
--                    insertion (C-4).
-- storage_state:     lifecycle of the raw_data payload (C-3).
--                    FULL         — complete payload stored as-is.
--                    EXTERNALIZED — payload moved to external storage (reserved, not implemented).
--                    PARTIAL      — payload was stored with known omissions (reserved).
--                    REJECTED     — payload exceeded absolute size limit; not stored.
--                    DEFAULT 'FULL' ensures existing rows are treated correctly (C-7).

-- ── blockchain_blocks ──

ALTER TABLE blockchain_blocks
  ADD COLUMN raw_data_bytes integer
    CHECK (raw_data_bytes IS NULL OR raw_data_bytes >= 0),
  ADD COLUMN raw_data_checksum text
    CHECK (raw_data_checksum IS NULL OR char_length(raw_data_checksum) = 64),
  ADD COLUMN storage_state text NOT NULL DEFAULT 'FULL'
    CHECK (storage_state IN ('FULL', 'EXTERNALIZED', 'PARTIAL', 'REJECTED')),
  ADD COLUMN storage_meta jsonb;

-- ── blockchain_transactions ──

ALTER TABLE blockchain_transactions
  ADD COLUMN raw_data_bytes integer
    CHECK (raw_data_bytes IS NULL OR raw_data_bytes >= 0),
  ADD COLUMN raw_data_checksum text
    CHECK (raw_data_checksum IS NULL OR char_length(raw_data_checksum) = 64),
  ADD COLUMN storage_state text NOT NULL DEFAULT 'FULL'
    CHECK (storage_state IN ('FULL', 'EXTERNALIZED', 'PARTIAL', 'REJECTED')),
  ADD COLUMN storage_meta jsonb;
