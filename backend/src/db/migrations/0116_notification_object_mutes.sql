-- Per-object notification mutes.
--
-- The missing escape valve. During a known incident — a node being rebuilt, a
-- mailbox deliberately left full, a domain mid-migration — the only tool an
-- operator had was muting the whole CATEGORY, which silences every other
-- object it covers and is almost never turned back on. A mute that is scoped
-- and expiring is the difference between "quiet about this one thing until
-- Friday" and "quiet about node health forever".
--
-- Expiry is mandatory (NOT NULL): an indefinite mute is how a category gets
-- silenced permanently by accident, and the retention pass reaps expired rows
-- so the table cannot grow without bound.
CREATE TABLE IF NOT EXISTS notification_object_mutes (
  id            VARCHAR(36) PRIMARY KEY,
  category_id   VARCHAR(64),
  object_key    VARCHAR(255) NOT NULL,
  muted_until   TIMESTAMPTZ  NOT NULL,
  reason        TEXT,
  created_by    VARCHAR(36),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- The dispatcher's lookup: "is (category, object) muted right now?" A NULL
-- category_id means the object is muted across every category that names it.
CREATE INDEX IF NOT EXISTS notification_object_mutes_lookup_idx
  ON notification_object_mutes (object_key, category_id, muted_until);

-- One active mute per (category, object). Re-muting extends rather than
-- accumulating rows.
CREATE UNIQUE INDEX IF NOT EXISTS notification_object_mutes_unique_idx
  ON notification_object_mutes (COALESCE(category_id, ''), object_key);
