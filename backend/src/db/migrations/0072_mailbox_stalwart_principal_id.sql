-- Migration 0072: add stalwart_principal_id to mailboxes table.
-- Stalwart 0.16 owns the authoritative copy of each mailbox as a Principal
-- in its own JMAP directory. The platform mirrors those rows in the mailboxes
-- table for fast pagination / offline display. This column tracks the Stalwart
-- principal ID so we can call destroyPrincipal(id) on delete without a
-- reverse lookup.
-- Nullable: legacy rows created before the 0.16 migration have no ID;
-- the principals-sync reconciler backfills it on the next cycle.

ALTER TABLE mailboxes
  ADD COLUMN IF NOT EXISTS stalwart_principal_id TEXT;

CREATE INDEX IF NOT EXISTS mailboxes_stalwart_principal_idx
  ON mailboxes (stalwart_principal_id)
  WHERE stalwart_principal_id IS NOT NULL;
