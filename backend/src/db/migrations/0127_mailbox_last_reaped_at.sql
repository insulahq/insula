-- Track when a platform intake mailbox was last emptied.
--
-- The existing reap fires at 40 MB, which in practice never happens: Stalwart's
-- report-analysis intercepts and parses mail to a registered report address
-- before it is stored, so every one of these mailboxes measures 0 MB. A size
-- trigger that cannot fire is not a retention policy.
--
-- Operator decision 2026-09-16: empty them every 30 days regardless of size,
-- so anything that DOES land (a DSN Stalwart chose not to consume, a report it
-- could not parse) cannot accumulate indefinitely. The size trigger stays as
-- the safety net for a sudden flood between cycles.
--
-- NULL means "never reaped": the first pass after this migration stamps a
-- baseline rather than reaping all of them at once, so a deploy does not
-- delete-and-recreate every intake mailbox in the same tick.
ALTER TABLE mailboxes
  ADD COLUMN IF NOT EXISTS last_reaped_at TIMESTAMPTZ;

-- Baseline the existing rows to NOW() so the first age-based reap happens one
-- full cycle from this deploy, not immediately.
UPDATE mailboxes SET last_reaped_at = NOW()
 WHERE platform_managed = TRUE AND last_reaped_at IS NULL;

CREATE INDEX IF NOT EXISTS mailboxes_platform_reap_idx
  ON mailboxes (last_reaped_at) WHERE platform_managed = TRUE;
