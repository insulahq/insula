-- Master notification kill switch.
--
-- On 2026-09-16 a reconciler bug mailed five tenants every five minutes for
-- 45 minutes. The only lever available to stop it was an operator running
-- `UPDATE notification_categories SET is_active = false` over psql, per
-- category, against the production database — which requires knowing which
-- category is storming, having DB access, and being willing to edit rows by
-- hand during an incident.
--
-- This is that lever, as one switch the operator can reach from the admin
-- panel. Default TRUE: a fresh install notifies.
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;
