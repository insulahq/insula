-- Notification system Phase 1: per-user preferences + global settings.
--
-- Two tables:
--   user_notification_preferences — per (category, channel) opt-in flag.
--     Absent row = use category default (default_channels).
--     enabled=FALSE on a row = user has explicitly opted out.
--     Mandatory categories (notification_categories.is_mandatory=true)
--     IGNORE this table for in_app + email — the dispatcher enforces
--     hard-on regardless of opt-out.
--   user_notification_settings — once-per-user knobs (quiet hours, digest,
--     timezone). Quiet hours suppress non-critical severities; critical
--     always punches through.

CREATE TABLE user_notification_preferences (
  user_id      VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id  VARCHAR(64) NOT NULL REFERENCES notification_categories(id) ON DELETE CASCADE,
  channel      channel_id_enum NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category_id, channel)
);

CREATE TABLE user_notification_settings (
  user_id            VARCHAR(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Stored as 'HH:MM' or 'HH:MM:SS' strings (Drizzle has no first-class
  -- TIME helper). Application validates the format with a Zod regex
  -- before persisting; preferences/quiet-hours.ts parses both forms.
  quiet_hours_start  VARCHAR(8),
  quiet_hours_end    VARCHAR(8),
  timezone           VARCHAR(50),
  digest_mode        VARCHAR(16) NOT NULL DEFAULT 'immediate',
  locale             VARCHAR(8) NOT NULL DEFAULT 'en',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_notification_settings_digest_check
    CHECK (digest_mode IN ('immediate', 'hourly', 'daily')),
  CONSTRAINT user_notification_settings_quiet_pair
    CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL))
);
