-- Persist the canonical mail hostname + drop the vestigial column.
--
-- The single source of truth for the mail server hostname is
-- platform_settings.mail_server_hostname — surfaced in Admin → Email →
-- Server (GET/PATCH /admin/webmail-settings.mailServerHostname) and read
-- by the Stalwart cert-anchor reconciler (getExplicitMailHostname). It was
-- never persisted on most clusters; the resolver fell back to the computed
-- mail.<ingress_base_domain> default. This backfills it to a concrete
-- stored value (fresh installs get the same via seed.ts), only when unset
-- — an operator-chosen hostname is preserved.
INSERT INTO platform_settings (setting_key, setting_value, updated_at)
SELECT 'mail_server_hostname',
       'mail.' || rtrim(trim(setting_value), '.'),
       NOW()
FROM platform_settings
WHERE setting_key = 'ingress_base_domain'
  AND NULLIF(trim(setting_value), '') IS NOT NULL
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = COALESCE(NULLIF(platform_settings.setting_value, ''), EXCLUDED.setting_value),
    updated_at = NOW();

-- NOTE: the vestigial system_settings.mail_hostname column is RETIRED in
-- code as of this release (removed from the Drizzle schema, api-contracts,
-- routes and the admin panel — nothing reads or writes it). The physical
-- `ALTER TABLE ... DROP COLUMN` is deliberately DEFERRED to a follow-up
-- migration: dropping it here would break still-running old backend pods
-- during a rolling deploy (their Drizzle schema still SELECTs the column
-- → undefined_column 500s until they're replaced). This project has no
-- prior DROP COLUMN migration, so we follow expand/contract: ship the
-- code change first, drop the now-orphaned column in a later release.
