-- Plesk migration source: keyfile OR password SSH auth.
--
-- A source previously always stored an SSH private key. It can now
-- authenticate with EITHER a key OR a password. `auth_method` records which
-- credential is populated; the SSH key column becomes nullable and a new
-- (AES-256-GCM encrypted) password column is added. Existing rows are all
-- key-based — the default 'key' is correct for them.
ALTER TABLE plesk_sources ADD COLUMN IF NOT EXISTS auth_method VARCHAR(16) NOT NULL DEFAULT 'key';
ALTER TABLE plesk_sources ADD COLUMN IF NOT EXISTS ssh_password_encrypted TEXT;
ALTER TABLE plesk_sources ALTER COLUMN ssh_key_encrypted DROP NOT NULL;
