-- Queued items for the periodic notification digest.
--
-- `user_notification_settings.digest_mode` has existed since the preferences
-- module shipped, with values 'immediate' | 'hourly' | 'daily', exposed in the
-- API and rendered in the tenant panel. NOTHING read it. A user could select
-- "daily digest", see it saved, and keep receiving every email immediately --
-- the same defect as `audience`, which was likewise stored, displayed and
-- ignored.
--
-- An item is queued instead of sent when the recipient asked for a digest AND
-- the notification's class is digestible (ambient, record, action). Incident,
-- Availability and Security are never queued: a digest is a delay, and those
-- three are the classes that cannot wait.
CREATE TABLE IF NOT EXISTS notification_digest_items (
  id           VARCHAR(36) PRIMARY KEY,
  user_id      VARCHAR(36)  NOT NULL,
  category_id  VARCHAR(64)  NOT NULL,
  subject      VARCHAR(500) NOT NULL,
  body         TEXT         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);

-- The flush query: unsent items for one user, oldest first.
CREATE INDEX IF NOT EXISTS notification_digest_items_pending_idx
  ON notification_digest_items (user_id, created_at)
  WHERE sent_at IS NULL;

-- The retention query: sent items past the window.
CREATE INDEX IF NOT EXISTS notification_digest_items_sent_idx
  ON notification_digest_items (sent_at)
  WHERE sent_at IS NOT NULL;
