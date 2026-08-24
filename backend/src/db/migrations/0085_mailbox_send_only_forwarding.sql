-- 0085_mailbox_send_only_forwarding.sql
--
-- Send-only mail accounts + per-mailbox forwarding.
--
-- WHY:
--   1. `mailbox_type` gains `send_only` — an SMTP-submission-only account
--      (e.g. no-reply@) with no usable inbox. Stalwart-side it gets
--      `disabledPermissions` (imapAuthenticate / pop3Authenticate /
--      sieveAuthenticate) and a platform-managed Sieve script that either
--      bounces inbound mail (ereject) or forwards it without storing.
--   2. `forwarding_addresses` — per-mailbox forwarding targets, realised
--      as a platform-managed Sieve script ("platform-mail-rules") with
--      `redirect :copy` (normal mailboxes keep a local copy) or plain
--      `redirect` (send-only accounts store nothing).
--   3. The legacy `forward_only` enum value was dead weight: no API ever
--      created it and no code branched on it. Any hypothetical rows are
--      folded into `mailbox`. The enum value itself stays (dropping a
--      Postgres enum value requires a full type rewrite — not worth it).
--
-- NOTE: ALTER TYPE ... ADD VALUE executes in its own implicit transaction
-- and is therefore kept as a standalone statement (see 0068 precedent).
-- Idempotent: ADD VALUE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS — safe
-- to re-run.

ALTER TYPE "mailbox_type" ADD VALUE IF NOT EXISTS 'send_only';

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "forwarding_addresses" jsonb;

COMMENT ON COLUMN "mailboxes"."forwarding_addresses" IS
  'Forwarding targets (JSON array of email addresses; NULL/[] = off). Realised as the platform-managed Sieve script "platform-mail-rules" in Stalwart: mailbox type keeps a local copy (redirect :copy), send_only forwards without storing. Platform DB is authoritative; re-pushed on boot reconcile.';

-- Fold dead legacy rows into the real type. No API path could ever have
-- created `forward_only` rows (the create UI never sent mailbox_type and
-- the backend never branched on it), so this is a no-op on real clusters.
-- NOTE the column is camelCase "mailboxType" (0000 created it from the
-- Drizzle property name — no explicit snake_case column name), while the
-- enum TYPE is snake_case "mailbox_type".
UPDATE "mailboxes" SET "mailboxType" = 'mailbox' WHERE "mailboxType" = 'forward_only';
