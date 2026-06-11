-- 0055: mail_drift_items allows kind='orphan-domain' + resolved_via='deleted'
--
-- R17.2 (2026-06-11): the principals-sync reconciler now also detects the
-- INVERSE drift direction — Stalwart Domain principals that no platform
-- email_domains row references (rename-away cert anchors, pre-#29 cascade
-- deletions). Items carry kind='orphan-domain'; their operator-confirmed
-- remediation (delete-orphan) resolves them via 'deleted'.
--
-- Without this widening both INSERTs are rejected by the CHECK constraints
-- from migration 0032 (caught live on testing 2026-06-11: the detector's
-- first tick failed with mail_drift_kind_check and the orphan surface was
-- silently empty).
--
-- Idempotent: DROP IF EXISTS then re-add. No data migration — existing rows
-- all use previously-valid values and remain valid.

ALTER TABLE mail_drift_items DROP CONSTRAINT IF EXISTS mail_drift_kind_check;
ALTER TABLE mail_drift_items ADD CONSTRAINT mail_drift_kind_check
  CHECK (kind IN ('domain', 'mailbox', 'master-user', 'orphan-domain'));

ALTER TABLE mail_drift_items DROP CONSTRAINT IF EXISTS mail_drift_resolved_via_check;
ALTER TABLE mail_drift_items ADD CONSTRAINT mail_drift_resolved_via_check
  CHECK (
    resolved_via IS NULL OR resolved_via IN ('recreated', 'restored', 'dismissed', 'reappeared', 'deleted')
  );
