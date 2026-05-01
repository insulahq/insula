-- Migration 0068: Add verification result cache columns to domains table.
-- verification_cache_at: when the last verification ran (used for 24h TTL check)
-- verification_cache_result: JSONB snapshot of VerificationResult so the FE can
--   show a stale result instantly without re-running DNS lookups.

ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS verification_cache_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_cache_result JSONB;
