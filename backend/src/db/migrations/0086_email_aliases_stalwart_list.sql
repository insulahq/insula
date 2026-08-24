-- 0086_email_aliases_stalwart_list.sql
--
-- Email aliases become REAL (ROADMAP R28 remainder).
--
-- WHY: `email_aliases` rows were never pushed to the mail server — the
-- "Aliases & Forwarding" tab silently did nothing and alias mail was
-- rejected as unknown-recipient. Each enabled alias now provisions a
-- Stalwart MailingList (source address = list address, destinations =
-- recipients — local or external, fan-out verified live on v0.16.16).
-- `stalwart_list_id` records the provisioned list's id, mirroring
-- mailboxes.stalwart_principal_id; NULL = not yet provisioned (the
-- boot reconcile converges it).
--
-- The domain-level catch-all (`email_domains.catch_all_address`, also
-- previously DB-only) maps onto Stalwart's native Domain.catchAllAddress
-- and needs no schema change.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run.

ALTER TABLE "email_aliases" ADD COLUMN IF NOT EXISTS "stalwart_list_id" text;

COMMENT ON COLUMN "email_aliases"."stalwart_list_id" IS
  'Stalwart MailingList id backing this alias (NULL = not provisioned yet; boot reconcile converges). Platform DB is authoritative.';
