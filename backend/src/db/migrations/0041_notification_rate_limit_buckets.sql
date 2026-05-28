-- Notification system Phase 1: per-(user, category) rate-limit buckets.
--
-- Postgres-backed (no Redis since M14). Bucket key is composite:
--   'cat:<category_id>:user:<user_id>:win:<window_start_unix>'
-- The window_start is computed from now() and the category's
-- rate_limit_window_s — so all buckets within the same window collide on
-- the same row and increment is an INSERT ... ON CONFLICT DO UPDATE.
--
-- Cleanup: a daily cron deletes rows older than 24h. Keeps the table
-- small even at high notification volume.

CREATE TABLE notification_rate_limit_buckets (
  bucket_key    VARCHAR(255) PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL
);

CREATE INDEX notification_rate_limit_buckets_purge_idx
  ON notification_rate_limit_buckets(window_end);
