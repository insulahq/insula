-- Widen mail_drift_items.kind — and fix a constraint that has been silently
-- discarding drift since 2026-08-25.
--
-- The detector gained kind='orphan-list' on 2026-08-25 (a Stalwart MailingList
-- with no email_aliases row: a live forwarder nobody owns). No migration
-- widened the CHECK, so `mail_drift_kind_check` still allowed only
--
--     ('domain', 'mailbox', 'master-user', 'orphan-domain')
--
-- Every orphan-list insert therefore violated the constraint. The inserts run
-- in a per-item loop inside reconcileDriftItems with no per-row guard, so the
-- first such item threw out of the whole persistence step: items detected
-- later in the same tick were never written, and — worse — the "these items
-- are gone, mark them resolved" sweep at the end never ran. A cluster with one
-- orphan list therefore showed a drift list that could never be cleared.
--
-- This is the SECOND time this exact trap has fired: migration 0055 was
-- written because kind='orphan-domain' hit the same constraint and "the
-- orphan surface was silently empty". Hence the two new kinds are added here
-- in the same change that starts emitting them.
--
--   kind='alias'        — an ENABLED mailbox_aliases row whose address Stalwart
--                         does not know, while its parent mailbox IS synced.
--                         The platform believes the address accepts mail; SMTP
--                         answers 550. platform_row_id = mailbox_aliases.id.
--   kind='orphan-alias' — the inverse: an address live on a principal the
--                         platform owns that no platform row claims. Created
--                         out of band, or left behind when an alias delete
--                         half-failed. platform_row_id is synthetic
--                         (`orphan-alias:<address>`), because there IS no row.
--
-- Idempotent: DROP IF EXISTS then re-add. No data migration — every existing
-- row holds a previously-valid value and stays valid.

ALTER TABLE mail_drift_items DROP CONSTRAINT IF EXISTS mail_drift_kind_check;
ALTER TABLE mail_drift_items ADD CONSTRAINT mail_drift_kind_check
  CHECK (kind IN (
    'domain',
    'mailbox',
    'master-user',
    'orphan-domain',
    'orphan-list',
    'alias',
    'orphan-alias'
  ));
