-- Notification system Phase 2: store event variables on the delivery
-- row so the queue worker can re-render the template at send time
-- (without re-running recipient resolution / preference checks).
--
-- These are the Handlebars variables passed to emitEvent (tenantName,
-- subscriptionPlan, etc.) — domain data, not recipient PII. We never
-- store the rendered body or the recipient address; the GDPR design
-- of `recipient_hash` + `content_hash` is preserved.
--
-- Set to NULL on terminal status (sent/dlq) by a cleanup pass after
-- 7d retention to bound stale-row growth.

ALTER TABLE notification_deliveries
  ADD COLUMN event_variables JSONB;
