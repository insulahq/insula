-- Passkey (WebAuthn) credentials and supporting tables.
--
-- See: docs/04-deployment/PASSKEY_AUTH.md (created in this milestone)
-- and project_phase3_split_token_auth_2026_04_27 memory note for the
-- existing access/refresh token model that passkey login plugs into.
--
-- Design summary:
--   * Password is permanent — users.password_hash is never nulled.
--   * Per-user opt-in via users.passkey_mode:
--       NULL            → password only (default)
--       'alternative'   → password OR passkey
--       'second_factor' → password AND passkey (2-step login)
--   * userHandle in WebAuthn assertions is users.passkey_user_handle
--     (random 32 bytes), NOT users.id, so the DB row UUID never leaks
--     to authenticators / password managers.
--   * Pre-auth tokens (issued after step-1 password in 2FA mode) are
--     single-use, server-tracked in auth_consumed_tokens. Required
--     because the platform-api has 3 replicas — in-memory cache
--     wouldn't survive load balancing.

-- ── Per-user passkey settings ───────────────────────────────────────
-- passkey_mode is opt-in. NULL means "no passkey configured for this
-- user"; setting it to 'second_factor' requires ≥1 verified passkey
-- (enforced in service layer) so users can't lock themselves out.
ALTER TABLE users ADD COLUMN passkey_mode VARCHAR(16);
ALTER TABLE users ADD CONSTRAINT users_passkey_mode_check
  CHECK (passkey_mode IS NULL OR passkey_mode IN ('alternative', 'second_factor'));

-- Random per-user handle. WebAuthn embeds this in every assertion's
-- userHandle field — using a non-derived random value keeps users.id
-- out of credential storage on third-party password managers.
ALTER TABLE users ADD COLUMN passkey_user_handle BYTEA;
CREATE UNIQUE INDEX users_passkey_user_handle_unique
  ON users (passkey_user_handle)
  WHERE passkey_user_handle IS NOT NULL;

-- ── Passkey credentials (one row per registered authenticator) ──────
CREATE TABLE user_passkeys (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The credential ID returned by the authenticator. Unique across
  -- the relying party. Bytea so we don't have to base64-decode on
  -- every lookup.
  credential_id BYTEA NOT NULL,
  -- COSE-encoded public key. Used to verify assertions.
  public_key BYTEA NOT NULL,
  -- Counter to detect cloned authenticators. Synced passkeys (Apple,
  -- 1Password, Bitwarden) often report 0 forever; the rollback check
  -- only fires when stored > 0 to avoid false positives.
  sign_count INTEGER NOT NULL DEFAULT 0,
  -- Authenticator transports (usb, nfc, ble, internal, hybrid). JSON
  -- array, mostly informational for the UI.
  transports JSONB,
  -- Authenticator AAGUID (model identifier). Optional; some platforms
  -- omit it.
  aaguid VARCHAR(36),
  -- User-supplied label for the UI ("YubiKey 5C", "iPhone").
  nickname VARCHAR(100) NOT NULL,
  -- Backup-eligible/backed-up flags from the assertion's authData.
  -- Backed-up means the credential is synced (e.g. iCloud Keychain).
  backup_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX user_passkeys_credential_id_unique ON user_passkeys (credential_id);
CREATE INDEX user_passkeys_user_idx ON user_passkeys (user_id);

-- ── Ephemeral WebAuthn challenges ────────────────────────────────────
-- One row per begin*() call. Single-use, expires in 5 min. Cron
-- prunes stale rows nightly.
CREATE TABLE passkey_challenges (
  id VARCHAR(36) PRIMARY KEY,
  challenge BYTEA NOT NULL,
  -- 'register' | 'login_userless' | 'login_2fa'
  purpose VARCHAR(16) NOT NULL,
  -- Set on register and login_2fa; NULL for userless login (the user
  -- isn't known until the assertion comes back with a userHandle).
  user_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
  -- Panel that originated the challenge. Login verify enforces the
  -- caller's panel matches both the challenge and the resolved user.
  panel VARCHAR(16) NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX passkey_challenges_expires_idx ON passkey_challenges (expires_at);
CREATE INDEX passkey_challenges_user_idx ON passkey_challenges (user_id);

-- ── Server-side single-use tokens (pre-auth + reset 2FA-clear) ───────
-- 3-replica platform-api can't trust an in-memory JTI cache to
-- prevent replay. This table is the source of truth for "this token
-- was already consumed". TTL cleanup via cron.
CREATE TABLE auth_consumed_tokens (
  jti VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose VARCHAR(32) NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX auth_consumed_tokens_expires_idx ON auth_consumed_tokens (expires_at);
