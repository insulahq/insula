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

-- NO CHECK CONSTRAINT HERE. The first draft of this migration added
--
--   CHECK (user_id IS NOT NULL OR recipient_address IS NOT NULL OR channel = 'ntfy')
--
-- on the reasoning that a row with no recipient is undeliverable. It is -- but
-- the constraint forbids a state this schema DELIBERATELY produces:
-- `user_id` carries ON DELETE SET NULL precisely so the delivery audit row
-- survives the deletion of the user it was sent to, which is how the platform
-- satisfies GDPR right-to-erasure without destroying the billing/aggregate
-- record.
--
-- It failed on the DEV cluster on first apply: 164 of 458 existing rows are
-- erased-recipient audit rows, so ADD CONSTRAINT aborted, the pod crash-looped,
-- and the column above had already committed -- leaving the migration half
-- applied. Those 164 rows are not dead rows to be cleaned up; they are the
-- audit trail working as designed, and the 30-day delivery retention removes
-- them on its own schedule.
--
-- The invariant is real but belongs at WRITE time, where a recipient is always
-- known, not as a table-level rule that a legitimate erasure can violate. It is
-- enforced in dispatcher/dispatch.ts and covered by a unit test.
--
-- Dropped defensively so any cluster that did get the constraint converges.
ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_recipient_present;
