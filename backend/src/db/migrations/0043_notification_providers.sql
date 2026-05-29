-- Notification Providers — dedicated transport endpoints for the
-- notification system. Distinct from `smtp_relay_configs` which is for
-- TENANT-side outbound email (catalog of relays a tenant can pick for
-- their own domain).
--
-- Why separate:
--   - Tenant mail and platform-internal notifications have different
--     security boundaries (the platform's sender is platform-owned, the
--     tenant's senders are tenant-owned).
--   - A notification-provider failure / mis-configuration must not
--     interfere with tenant mail delivery and vice versa.
--   - Per-tenant overrides (Phase 5+: e.g. enterprise plan brings own
--     Postmark) belong on this table, scoped by tenant_id.
--
-- Phase 3 ships only the platform-scope (`scope='platform'`) variant.
-- The tenant-scoped variant is reserved by the column for forward
-- compatibility but the routes refuse to write tenant-scoped rows yet.
--
-- The `notification_provider_type` enum covers the provider kinds we
-- support today (in-cluster Stalwart, generic SMTP, Postmark, Brevo,
-- Mailjet, Mailgun-EU). Adding a kind is an ENUM ADD VALUE migration.
--
-- Auth credentials live in `auth_password_encrypted` (PLATFORM_ENCRYPTION_KEY
-- AES-256-GCM) — same scheme as smtp_relay_configs. Never logged, never
-- returned by the GET endpoint.

CREATE TYPE notification_provider_type AS ENUM (
  'stalwart-internal',
  'smtp',
  'postmark',
  'brevo',
  'mailjet',
  'mailgun-eu'
);

CREATE TABLE notification_providers (
  id                       VARCHAR(36) PRIMARY KEY,
  name                     VARCHAR(255) NOT NULL,
  provider_type            notification_provider_type NOT NULL,
  -- 'platform' = the default sender for all platform notifications.
  -- 'tenant'   = future per-tenant override (Phase 5+). Phase 3 only
  --              writes 'platform'.
  scope                    VARCHAR(16) NOT NULL DEFAULT 'platform',
  tenant_id                VARCHAR(36) REFERENCES tenants(id) ON DELETE CASCADE,
  -- Channel narrowed to email for Phase 3; future channels (sms,
  -- webhook) get their own provider types and the channel value
  -- discriminates the union shape.
  channel                  channel_id_enum NOT NULL DEFAULT 'email',
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  -- SMTP transport fields. Required when provider_type IN
  -- ('stalwart-internal', 'smtp'). For SaaS provider types
  -- (postmark/brevo/...) the smtp_host/port/auth_* are also used since
  -- those providers expose SMTP submission endpoints — we use SMTP for
  -- everything in Phase 3, an API-based send path is a Phase 4+ option.
  smtp_host                VARCHAR(255),
  smtp_port                INTEGER NOT NULL DEFAULT 587,
  smtp_secure              BOOLEAN NOT NULL DEFAULT FALSE,
  auth_username            VARCHAR(255),
  auth_password_encrypted  VARCHAR(500),
  from_address             VARCHAR(255) NOT NULL,
  from_name                VARCHAR(255),
  region                   VARCHAR(50),
  -- Last test-send outcome surfaced in the admin UI. Updated on every
  -- POST /admin/notifications/providers/:id/test call.
  last_tested_at           TIMESTAMPTZ,
  last_test_status         VARCHAR(32),
  last_test_error          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id       VARCHAR(36),
  CONSTRAINT notification_providers_scope_check
    CHECK (scope IN ('platform', 'tenant')),
  CONSTRAINT notification_providers_scope_tenant_pair
    CHECK ((scope = 'tenant') = (tenant_id IS NOT NULL)),
  CONSTRAINT notification_providers_last_test_status_check
    CHECK (last_test_status IS NULL OR last_test_status IN ('success', 'failed'))
);

-- At most one default platform-scope provider per channel.
CREATE UNIQUE INDEX notification_providers_default_platform_channel_idx
  ON notification_providers(channel)
  WHERE is_default = TRUE AND scope = 'platform';

-- At most one default tenant-scope provider per (tenant, channel).
CREATE UNIQUE INDEX notification_providers_default_tenant_channel_idx
  ON notification_providers(tenant_id, channel)
  WHERE is_default = TRUE AND scope = 'tenant';

CREATE INDEX notification_providers_channel_idx
  ON notification_providers(channel) WHERE enabled = TRUE;
CREATE INDEX notification_providers_tenant_idx
  ON notification_providers(tenant_id) WHERE tenant_id IS NOT NULL;
