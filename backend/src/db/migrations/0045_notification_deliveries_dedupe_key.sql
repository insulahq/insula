-- Notification system Phase 4 follow-up: dedupe_key on
-- notification_deliveries.
--
-- The dispatcher already writes dedupe_key on the notifications row
-- (in_app channel). For email-only categories that path is never
-- written, so an idempotency check that only consulted `notifications`
-- would always miss the prior delivery and re-fire the email on
-- every scheduler tick.
--
-- Per-channel dedupe by writing the key on every delivery row, then
-- the dispatcher's findDedupedNotification helper can query
-- notification_deliveries (which is written for every channel) to
-- decide whether to skip.
--
-- Partial index: only rows with a dedupe_key set are interesting for
-- this lookup; the rest of the table is dedupe-irrelevant.

ALTER TABLE notification_deliveries
  ADD COLUMN dedupe_key VARCHAR(128);

CREATE INDEX notification_deliveries_dedupe_lookup_idx
  ON notification_deliveries(user_id, dedupe_key, queued_at DESC)
  WHERE dedupe_key IS NOT NULL;
