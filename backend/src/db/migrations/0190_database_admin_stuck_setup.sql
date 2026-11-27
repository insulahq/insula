-- database_admin_state: an instance whose set-up keeps failing.
--
-- stuck_since: since when its hardening pass (the removal of what a tenant
-- could have left while it held root) keeps failing — its tenant
-- administrator stays hidden meanwhile, and after six hours the incident is
-- announced like a lost login. harden_tried_at: the last try of a pass that
-- did not finish; it is tried again hourly, not on every ten-minute check.
--
-- Additive and replay-safe (IF NOT EXISTS) for the non-transactional runner.

ALTER TABLE database_admin_state ADD COLUMN IF NOT EXISTS stuck_since timestamptz;
ALTER TABLE database_admin_state ADD COLUMN IF NOT EXISTS harden_tried_at timestamptz;
