-- 0088_mailbox_aliases.sql
--
-- Per-mailbox aliases (alternate receive+send addresses on an existing
-- account) — distinct from `email_aliases`, which are mailbox-less
-- forwarding addresses backed by Stalwart MailingLists.
--
-- WHY: operators need info@/postmaster@/webmaster@ delivered into an
-- existing inbox AND replies sent AS the alias. A MailingList covers
-- delivery only — the list address is not registered on the account, so
-- Stalwart submission rejects MAIL FROM it and webmail offers no
-- identity. The account-level `aliases` map (x:Account, verified live on
-- v0.16.16 2026-08-25) covers both directions and enforcement is
-- server-side (unowned MAIL FROM → 501; disabled alias → 550/501).
--
-- No per-row Stalwart id: the alias set is pushed as the account's WHOLE
-- `aliases` map (derived from these rows), and the send-as JMAP Identity
-- is resolved by email address — both self-heal on restore/rebuild.
--
-- Aliases do NOT count against any plan quota (operator decision
-- 2026-08-25).
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS — safe to re-run.

CREATE TABLE IF NOT EXISTS "mailbox_aliases" (
  "id" varchar(36) PRIMARY KEY,
  "mailbox_id" varchar(36) NOT NULL REFERENCES "mailboxes"("id") ON DELETE CASCADE,
  "email_domain_id" varchar(36) NOT NULL REFERENCES "email_domains"("id") ON DELETE CASCADE,
  "tenant_id" varchar(36) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "local_part" varchar(64) NOT NULL,
  "full_address" varchar(255) NOT NULL,
  "enabled" integer NOT NULL DEFAULT 1,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- One row per address, across all tenants (an address exists once on the
-- mail server). Cross-table collisions vs mailboxes.full_address and
-- email_aliases.source_address are checked in the service layer with
-- Stalwart's own primaryKeyViolation as the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_aliases_full_address_uniq"
  ON "mailbox_aliases" ("full_address");

CREATE INDEX IF NOT EXISTS "mailbox_aliases_mailbox_id_idx"
  ON "mailbox_aliases" ("mailbox_id");

CREATE INDEX IF NOT EXISTS "mailbox_aliases_tenant_id_idx"
  ON "mailbox_aliases" ("tenant_id");

COMMENT ON TABLE "mailbox_aliases" IS
  'Alternate addresses attached to a mailbox (receive + send-as). Pushed to Stalwart as the account''s whole aliases map; platform DB is authoritative, boot reconcile converges.';
