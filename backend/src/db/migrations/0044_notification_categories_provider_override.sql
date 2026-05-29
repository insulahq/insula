-- Notification system Phase 5: per-Source provider routing override.
--
-- Lets an operator route a specific source through a non-default
-- email provider. For example, send `tenant.suspended` through a
-- transactional Postmark account but every other source through
-- the in-cluster Stalwart relay.
--
-- NULL means "use the default platform-scope provider for the
-- channel" (dispatcher / worker behaviour unchanged).
-- ON DELETE SET NULL so removing a provider doesn't orphan rows —
-- the source automatically falls back to the default once the
-- override is gone.
--
-- Phase 5 covers email only — when we add SMS/webhook channels we
-- will add a parallel sms_provider_id column rather than overloading
-- this one.

ALTER TABLE notification_categories
  ADD COLUMN email_provider_id VARCHAR(36) REFERENCES notification_providers(id) ON DELETE SET NULL;

CREATE INDEX notification_categories_email_provider_idx
  ON notification_categories(email_provider_id)
  WHERE email_provider_id IS NOT NULL;
