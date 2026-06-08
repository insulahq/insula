-- 0053: mail_drift_items.kind allows 'master-user'
--
-- The principals-sync reconciler now detects a missing Stalwart webmail
-- master user (the account Bulwark/Roundcube authenticate as to impersonate
-- every mailbox) and records it as a drift item with kind='master-user'.
-- The original CHECK (migration 0032) only permitted 'domain' | 'mailbox', so
-- without this widening the INSERT would be rejected and the master-user drift
-- (an ALL-webmail-login outage) would be silently swallowed.
--
-- Idempotent: DROP IF EXISTS then re-add. No data migration — existing rows
-- are all 'domain'/'mailbox' and remain valid.

ALTER TABLE mail_drift_items DROP CONSTRAINT IF EXISTS mail_drift_kind_check;
ALTER TABLE mail_drift_items ADD CONSTRAINT mail_drift_kind_check
  CHECK (kind IN ('domain', 'mailbox', 'master-user'));
