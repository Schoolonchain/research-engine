-- Add FALLBACK confidence level for metrics sourced from hardcoded static data
-- rather than live API responses (e.g. well-known token list when TronScan is down).

ALTER TABLE onchain_metrics
  DROP CONSTRAINT IF EXISTS onchain_metrics_confidence_check;

ALTER TABLE onchain_metrics
  ADD CONSTRAINT onchain_metrics_confidence_check
  CHECK (confidence IN ('DIRECT', 'DERIVED', 'ESTIMATED', 'FALLBACK'));
