-- The platform keeps an encrypted copy of each DKIM key it creates.
--
-- A domain owner may sign with the same key on another mail server, so the
-- record the platform published verifies mail from both. The key lives in
-- Stalwart, which masks every secret on read ("****"), so the platform keeps
-- its own copy when it generates one (enable, rotation, drift repair, DR
-- recreate), encrypted with PLATFORM_ENCRYPTION_KEY like an uploaded TLS key.
-- Keys created before this migration have no copy; rotating creates one.
--
-- One row per (email domain, selector): a rotation replaces the selector's key
-- and its row. CASCADE: the copy means nothing once the email domain is gone.
CREATE TABLE IF NOT EXISTS email_dkim_private_keys (
  email_domain_id        VARCHAR(36) NOT NULL REFERENCES email_domains(id) ON DELETE CASCADE,
  selector               VARCHAR(63) NOT NULL,
  private_key_encrypted  TEXT        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email_domain_id, selector)
);
