-- Migration runner note: backend/src/db/migrate.ts runs each statement
-- in this file via its own db.execute call (autocommit), so the
-- ALTER TYPE ADD VALUE below executes in its own implicit transaction
-- and is therefore allowed by Postgres. DO NOT wrap this file in
-- explicit BEGIN/COMMIT — that would re-introduce the multi-statement
-- transaction Postgres rejects for ALTER TYPE.
--
-- Notification system Phase 1: add 'stalwart-internal' provider type to
-- smtp_relay_configs. Lets the platform's own Stalwart instance act as
-- the transactional SMTP relay, authenticating with the master account
-- credentials stored in the stalwart-admin-creds K8s Secret.
--
-- The master account can submit mail with arbitrary From: addresses
-- (System Administrator role grants impersonate permission per ADR-040
-- and Stalwart 0.16 JMAP behaviour confirmed by the bootstrap spike).
-- So we can set From: notifications@<apex> without provisioning a
-- mailbox at that address.
--
-- We also add:
--   - from_address column so the chosen sender is explicit (not implicit
--     from authUsername). Defaults to NULL meaning "use authUsername".
--   - purpose column to mark a relay as 'transactional' (notifications)
--     vs 'tenant_mail' (currently unused — tenant mail goes through
--     Stalwart directly, not this table). Lets future installs add a
--     dedicated tenant-mail relay without notifications using it.

ALTER TYPE smtp_provider_type ADD VALUE IF NOT EXISTS 'stalwart-internal';

ALTER TABLE smtp_relay_configs
  ADD COLUMN from_address VARCHAR(255),
  ADD COLUMN purpose      VARCHAR(32) NOT NULL DEFAULT 'transactional';

ALTER TABLE smtp_relay_configs
  ADD CONSTRAINT smtp_relay_configs_purpose_check
    CHECK (purpose IN ('transactional', 'tenant_mail', 'both'));
