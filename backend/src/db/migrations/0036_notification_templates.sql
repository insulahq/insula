-- Notification system Phase 1: templates table.
--
-- Templates are (category, channel, locale)-keyed Handlebars sources. For
-- email the body is MJML which the renderer compiles to HTML; for in_app
-- it is plaintext. Templates are versioned in-place: PATCH bumps the
-- `version` column and pushes the previous row into `notification_template_versions`
-- so the audit log keeps the full history without bloating the hot table.
--
-- Variables_schema is a JSONB shape declaration (list of required var
-- names + types) used at emit-time to fail fast if a producer forgets to
-- pass a field a template references. Runtime-validated.
--
-- The is_seed flag marks templates that came from the application's stock
-- seed loader so admin edits don't get clobbered on upgrade — the loader
-- only INSERTs missing rows; never UPDATEs existing seed rows.

CREATE TABLE notification_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id         VARCHAR(64) NOT NULL REFERENCES notification_categories(id) ON DELETE CASCADE,
  channel             channel_id_enum NOT NULL,
  locale              VARCHAR(8) NOT NULL DEFAULT 'en',
  subject_template    TEXT,
  body_template       TEXT NOT NULL,
  body_format         VARCHAR(16) NOT NULL,
  variables_schema    JSONB,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  is_seed             BOOLEAN NOT NULL DEFAULT FALSE,
  version             INTEGER NOT NULL DEFAULT 1,
  edited_by_user_id   VARCHAR(36),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_templates_body_format_check
    CHECK (body_format IN ('mjml', 'html', 'plaintext', 'markdown')),
  CONSTRAINT notification_templates_locale_lowercase
    CHECK (locale = LOWER(locale))
);

CREATE UNIQUE INDEX notification_templates_unique_active_idx
  ON notification_templates(category_id, channel, locale)
  WHERE is_active = TRUE;

CREATE INDEX notification_templates_category_idx
  ON notification_templates(category_id);

CREATE TABLE notification_template_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         UUID NOT NULL REFERENCES notification_templates(id) ON DELETE CASCADE,
  category_id         VARCHAR(64) NOT NULL,
  channel             channel_id_enum NOT NULL,
  locale              VARCHAR(8) NOT NULL,
  subject_template    TEXT,
  body_template       TEXT NOT NULL,
  body_format         VARCHAR(16) NOT NULL,
  variables_schema    JSONB,
  version             INTEGER NOT NULL,
  edited_by_user_id   VARCHAR(36),
  archived_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX notification_template_versions_template_idx
  ON notification_template_versions(template_id, version DESC);
