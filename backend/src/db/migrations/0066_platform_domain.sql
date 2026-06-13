-- R16 PR-1 — decouple the platform APEX from the ingress/CNAME-target domain.
--
-- Adds system_settings.platform_domain (the brand apex) alongside
-- ingress_base_domain (which keeps its CNAME-target role). Seeds equal so the
-- upgrade is a zero-behaviour-change migration; consumers repoint to
-- platform_domain in PR-2. The value is mirrored into the platform_settings KV
-- table (key 'platform_domain') the same way ingress_base_domain is, so KV
-- consumers can read it. migrate runs before seed (docker-entrypoint.sh), so on
-- a fresh install the table is empty here and seed.ts inserts the final value.
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS platform_domain varchar(255);

-- Existing installs: seed the apex from the current ingress base domain.
UPDATE system_settings
   SET platform_domain = ingress_base_domain
 WHERE platform_domain IS NULL
   AND ingress_base_domain IS NOT NULL;

-- Mirror into the KV table from the existing ingress_base_domain KV row
-- (the cross-module apex source today). No-op on a fresh install (the KV row
-- doesn't exist yet — seed.ts writes both). The KV columns are
-- setting_key / setting_value.
INSERT INTO platform_settings (setting_key, setting_value, updated_at)
SELECT 'platform_domain', setting_value, NOW()
  FROM platform_settings
 WHERE setting_key = 'ingress_base_domain'
ON CONFLICT (setting_key) DO NOTHING;
