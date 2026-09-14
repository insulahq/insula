-- Deliveries addressed to someone who has no platform account.
--
-- A mailbox owner is not a user: `mailbox_access` is empty platform-wide, and
-- even when populated it maps panel users to mailboxes, not the mailbox's own
-- human. That is the structural reason the 80/90/100% mailbox-quota warnings
-- never reached anybody -- every recipient resolver in the system returns user
-- ids, and there was no user to return.
--
-- Rather than add a fourth delivery path, the existing one learns to address an
-- email directly: provider resolution, credential decryption, retry, DLQ and
-- the delivery audit are all reused unchanged.
ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS recipient_address VARCHAR(320);

-- Exactly one of user_id / recipient_address must identify the recipient.
-- Without this a row with neither is silently undeliverable, which is the
-- class of bug this whole change exists to remove.
ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_recipient_present;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_recipient_present
  CHECK (user_id IS NOT NULL OR recipient_address IS NOT NULL OR channel = 'ntfy');
