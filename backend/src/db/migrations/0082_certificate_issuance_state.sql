-- Certificate issuance state (ADR-058 follow-up).
--
-- `ssl_certificates` only ever recorded a SUCCESSFUL issuance: the
-- reconciler parsed the TLS Secret and upserted issuer/subject/expiry.
-- A Certificate that never completed wrote nothing at all, so a wildcard
-- order pointed at a missing solver looked exactly like one still in
-- progress — for weeks, with no error surfaced to tenant or admin.
--
-- These columns hold what cert-manager reports on the Certificate CR, so
-- the panels can show a real state and the reconciler can decide when to
-- put a working per-hostname certificate in front of the tenant.

ALTER TABLE ssl_certificates
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS challenge_type VARCHAR(10),
  ADD COLUMN IF NOT EXISTS issuer_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS is_wildcard INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fallback_active INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_issued_at TIMESTAMP,
  -- Cooldown anchor for the on-demand reissue button. Let's Encrypt
  -- caps duplicate certificates (same exact SAN set) at 5 per week, so
  -- an unthrottled button can burn a domain's issuance budget in a
  -- minute and lock it out for seven days.
  ADD COLUMN IF NOT EXISTS last_reissue_at TIMESTAMP;

-- Existing rows only exist because a certificate WAS parsed from a
-- Secret, so they are issued by definition. Leaving them 'unknown' would
-- light up every panel with a warning on upgrade.
UPDATE ssl_certificates
   SET status = 'issued',
       is_wildcard = CASE WHEN subject LIKE '*.%' THEN 1 ELSE 0 END,
       last_issued_at = COALESCE(last_issued_at, updated_at)
 WHERE status = 'unknown';

CREATE INDEX IF NOT EXISTS ssl_certs_status_idx ON ssl_certificates (status);
