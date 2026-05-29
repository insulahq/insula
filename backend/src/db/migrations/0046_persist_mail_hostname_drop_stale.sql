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

-- Drop the vestigial system_settings.mail_hostname column. It was
-- deprecated (the backend silently ignored writes — see
-- system-settings/routes.ts) and read by nothing; the canonical value
-- lives in platform_settings.mail_server_hostname (above).
ALTER TABLE system_settings DROP COLUMN IF EXISTS mail_hostname;
