-- Notification system Phase 1: categories table + supporting enums.
--
-- Categories are the "what kind of event" taxonomy. Each category has a
-- default severity, default channel set, mandatory/opt-out policy, and an
-- audience axis (tenant / admin / system). Seeded by application code at
-- boot (categories/seed.ts).
--
-- Why audience as a varchar instead of enum: makes adding 'system' (already
-- here) and any future scope label a one-line backend change with zero
-- migration. The runtime guards the allowed values.
--
-- Why default_channels as text[]: PostgreSQL array of channel ids; lets a
-- single category emit to in-app + email + (later) any operator channel
-- without a join table. The channel ids themselves are restricted by the
-- channel_id_enum type.

CREATE TYPE notification_severity_enum AS ENUM (
  'info',
  'warning',
  'error',
  'critical'
);

CREATE TYPE channel_id_enum AS ENUM (
  'in_app',
  'email'
);

-- GDPR legal basis flag — drives behaviour around opt-out enforcement.
-- 'contract' / 'legitimate_interest' notifications may be mandatory.
-- 'consent' notifications must always be opt-out-able.
CREATE TYPE notification_gdpr_basis_enum AS ENUM (
  'contract',
  'legitimate_interest',
  'consent'
);

CREATE TABLE notification_categories (
  id                    VARCHAR(64) PRIMARY KEY,
  display_name          VARCHAR(255) NOT NULL,
  description           TEXT,
  audience              VARCHAR(16) NOT NULL,
  default_severity      notification_severity_enum NOT NULL DEFAULT 'info',
  default_channels      TEXT[] NOT NULL DEFAULT ARRAY['in_app', 'email']::text[],
  is_mandatory          BOOLEAN NOT NULL DEFAULT FALSE,
  gdpr_basis            notification_gdpr_basis_enum NOT NULL DEFAULT 'legitimate_interest',
  rate_limit_window_s   INTEGER,
  rate_limit_max        INTEGER,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_categories_audience_check
    CHECK (audience IN ('tenant', 'admin', 'system')),
  CONSTRAINT notification_categories_rate_limit_pair
    CHECK ((rate_limit_window_s IS NULL) = (rate_limit_max IS NULL))
);

CREATE INDEX notification_categories_audience_idx
  ON notification_categories(audience) WHERE is_active = TRUE;
