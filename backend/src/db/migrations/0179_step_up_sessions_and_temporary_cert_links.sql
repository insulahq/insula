-- A step-up proves something only for the session that performed it.
--
-- Freshness used to be one timestamp per user (users.last_step_up_at), so a
-- second session of the same user — another browser, or a stolen token —
-- passed every step-up gate for 30 minutes after the owner stepped up
-- anywhere. A row here is keyed by the session (the refresh-token family the
-- access token belongs to, or the single token of a "Login as tenant"
-- session), and names whose credential was checked: under impersonation that
-- is the staff member's own, not the tenant user's.
CREATE TABLE IF NOT EXISTS auth_step_ups (
  session_id     VARCHAR(64) PRIMARY KEY,
  user_id        VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method         VARCHAR(16) NOT NULL,
  stepped_up_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Pruned on write: a row older than a day is dead, every window is shorter.
CREATE INDEX IF NOT EXISTS auth_step_ups_at_idx ON auth_step_ups (stepped_up_at);

-- Certificate download links are temporary now (15 minutes to 24 hours) and
-- reaped once expired. Every link minted under the old rules (up to a year,
-- or never expiring) is revoked. Unattended pickup uses an API token instead.
-- expires_at stays nullable for the rollout: a pod still on the old code may
-- mint a link meanwhile, and the new code refuses it and reaps it.
DELETE FROM cert_download_tokens;
CREATE INDEX IF NOT EXISTS cert_download_tokens_expires_idx ON cert_download_tokens (expires_at);
