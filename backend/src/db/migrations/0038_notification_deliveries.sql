-- Notification system Phase 1: durable per-channel delivery audit.
--
-- One row per (event_id, recipient, channel) — captures the full lifecycle
-- from queued → sending → sent / failed / dlq / skipped / muted / rate_limited.
--
-- GDPR-critical design:
--   - NO raw recipient (email / phone / webhook url) — we keep a sha256
--     hash so we can prove delivery to a specific subscriber without
--     storing PII. The hash is salted with PLATFORM_ENCRYPTION_KEY so it
--     can't be brute-forced offline.
--   - NO raw body — content_hash is sha256 of the rendered subject+body
--     so we can prove what was delivered without keeping the message.
--   - 30 day retention enforced by retention/purge.ts cron.
--   - Right-to-erasure cascades from users.id ON DELETE SET NULL (we keep
--     the row anonymous for billing/audit but lose the user link).

CREATE TABLE notification_deliveries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id       VARCHAR(36) REFERENCES notifications(id) ON DELETE CASCADE,
  event_id              UUID NOT NULL,
  user_id               VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  tenant_id             VARCHAR(36) REFERENCES tenants(id) ON DELETE SET NULL,
  category_id           VARCHAR(64) NOT NULL REFERENCES notification_categories(id) ON DELETE RESTRICT,
  channel               channel_id_enum NOT NULL,
  provider_id           VARCHAR(64),
  recipient_hash        VARCHAR(64),
  content_hash          VARCHAR(64) NOT NULL,
  template_id           UUID REFERENCES notification_templates(id) ON DELETE SET NULL,
  template_version      INTEGER NOT NULL,
  locale                VARCHAR(8) NOT NULL DEFAULT 'en',
  status                VARCHAR(16) NOT NULL DEFAULT 'queued',
  attempt               INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 6,
  next_attempt_at       TIMESTAMPTZ,
  last_error            TEXT,
  provider_message_id   VARCHAR(255),
  queued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at               TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  CONSTRAINT notification_deliveries_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'dlq', 'skipped', 'rate_limited', 'muted'))
);

-- Queue-scan index: workers select rows in queued/failed state ordered by
-- next_attempt_at to find the next batch to process.
CREATE INDEX notification_deliveries_queue_idx
  ON notification_deliveries(status, next_attempt_at)
  WHERE status IN ('queued', 'failed');

CREATE INDEX notification_deliveries_event_idx  ON notification_deliveries(event_id);
CREATE INDEX notification_deliveries_user_idx   ON notification_deliveries(user_id, queued_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX notification_deliveries_tenant_idx ON notification_deliveries(tenant_id, queued_at DESC) WHERE tenant_id IS NOT NULL;
CREATE INDEX notification_deliveries_category_idx ON notification_deliveries(category_id, queued_at DESC);
CREATE INDEX notification_deliveries_purge_idx  ON notification_deliveries(queued_at);
