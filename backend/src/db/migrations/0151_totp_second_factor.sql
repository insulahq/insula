-- Authenticator-app (TOTP) second factor for password sign-in, and the end of
-- passkey-as-second-factor. Idempotent.

-- One row per user who has started enrolment. enabled_at stays NULL until a
-- code from the app has confirmed the secret, so a half-finished setup never
-- gates sign-in.
CREATE TABLE IF NOT EXISTS "user_totp" (
  "user_id" varchar(36) PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  -- AES-256-GCM under PLATFORM_ENCRYPTION_KEY (iv:tag:ciphertext, hex).
  "secret_encrypted" text NOT NULL,
  "enabled_at" timestamptz,
  -- Highest time step a code was accepted for: a code works once.
  "last_used_step" bigint,
  -- Wrong codes in the current window, counted per USER (not per IP or replica).
  "failed_attempts" integer NOT NULL DEFAULT 0,
  "failed_window_started_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Single-use backup codes. Stored as HMAC-SHA256 under a key derived from
-- PLATFORM_ENCRYPTION_KEY — the codes are random, and the key keeps a copy of
-- this table alone from being brute-forced offline.
CREATE TABLE IF NOT EXISTS "user_totp_backup_codes" (
  "id" varchar(36) PRIMARY KEY,
  "user_id" varchar(36) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash" varchar(64) NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_totp_backup_codes_user_hash_unique"
  ON "user_totp_backup_codes" ("user_id", "code_hash");

-- A passkey is already two factors, so password-plus-passkey is retired: those
-- users now sign in with the passkey on its own (operator decision).
UPDATE "users" SET "passkey_mode" = 'alternative' WHERE "passkey_mode" = 'second_factor';
