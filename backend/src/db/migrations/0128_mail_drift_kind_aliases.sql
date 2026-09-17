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

-- NOT VALID on purpose. A plain ADD CONSTRAINT … CHECK re-validates every
-- existing row, and migration 0113 did exactly that and aborted against 164 of
-- 458 rows, crash-looping the API. The argument that it "cannot fail here"
-- because this constraint only WIDENS the allowed set (0032 ⊂ 0053 ⊂ 0055 ⊂
-- this one, so every stored value stays valid) is almost certainly the argument
-- 0113 was written with too. NOT VALID skips the scan of historical rows and
-- still enforces the check on every INSERT and UPDATE — which is the only thing
-- this constraint is for. Nothing reads old rows expecting them to satisfy it.
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
  )) NOT VALID;
