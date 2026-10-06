-- oidc_global_settings: the OIDC provider each panel's oauth2-proxy signs in with.
--
-- oauth2-proxy accepts exactly ONE provider. Until now it was configured from a
-- static Secret written by bootstrap.sh (an in-cluster Dex issuer), never from
-- the providers the operator manages — so on a cluster without Dex (production)
-- "Protect … via OAuth2 Proxy" pointed every panel route at a proxy that did not
-- exist and the panel answered 404. The proxy is now created by platform-api
-- from the provider chosen here.
--
-- Backfill: a panel that is already protected and has exactly ONE enabled
-- provider of its scope adopts that provider. A panel that is protected with
-- none or several cannot be configured unambiguously, so its protection is
-- switched off (it could not have been working: see above) and the operator
-- picks a provider in Security → OIDC before switching it back on.
--
-- Idempotent.
ALTER TABLE "oidc_global_settings" ADD COLUMN IF NOT EXISTS "proxy_admin_provider_id" varchar(36);
ALTER TABLE "oidc_global_settings" ADD COLUMN IF NOT EXISTS "proxy_tenant_provider_id" varchar(36);

DO $$ BEGIN
  ALTER TABLE "oidc_global_settings" ADD CONSTRAINT "oidc_global_settings_proxy_admin_provider_fk"
    FOREIGN KEY ("proxy_admin_provider_id") REFERENCES "oidc_providers"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "oidc_global_settings" ADD CONSTRAINT "oidc_global_settings_proxy_tenant_provider_fk"
    FOREIGN KEY ("proxy_tenant_provider_id") REFERENCES "oidc_providers"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE "oidc_global_settings"
   SET "proxy_admin_provider_id" = (SELECT "id" FROM "oidc_providers" WHERE "panelScope" = 'admin' AND "enabled" = 1)
 WHERE "protect_admin_via_proxy" = 1 AND "proxy_admin_provider_id" IS NULL
   AND (SELECT count(*) FROM "oidc_providers" WHERE "panelScope" = 'admin' AND "enabled" = 1) = 1;
UPDATE "oidc_global_settings"
   SET "proxy_tenant_provider_id" = (SELECT "id" FROM "oidc_providers" WHERE "panelScope" = 'tenant' AND "enabled" = 1)
 WHERE "protect_tenant_via_proxy" = 1 AND "proxy_tenant_provider_id" IS NULL
   AND (SELECT count(*) FROM "oidc_providers" WHERE "panelScope" = 'tenant' AND "enabled" = 1) = 1;

UPDATE "oidc_global_settings" SET "protect_admin_via_proxy" = 0
 WHERE "protect_admin_via_proxy" = 1 AND "proxy_admin_provider_id" IS NULL;
UPDATE "oidc_global_settings" SET "protect_tenant_via_proxy" = 0
 WHERE "protect_tenant_via_proxy" = 1 AND "proxy_tenant_provider_id" IS NULL;
