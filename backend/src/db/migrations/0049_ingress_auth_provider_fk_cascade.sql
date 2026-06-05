-- 0049: ingress_auth_configs.provider_id → ON DELETE CASCADE
--
-- The RESTRICT FK made tenants with an attached ingress-auth config
-- UNDELETABLE through the lifecycle: deleting a tenant cascades
-- tenants → tenant_oidc_providers, which hit the RESTRICT on
-- ingress_auth_configs and aborted the whole transition with a raw FK
-- error (observed live on staging 2026-06-05 — the leaked
-- oidc-harness tenant could not be deleted until the row was removed
-- by hand; integration-cleanup.sh would have failed the same way, so
-- killed harness runs leaked tenants permanently).
--
-- Direct provider deletion stays guarded at the API layer:
-- ingress-auth/providers-service.ts deleteProvider() throws
-- PROVIDER_IN_USE 409 when any config references the provider — the
-- DB-level RESTRICT was belt-and-suspenders there, but it also
-- strangled the tenant cascade. An auth config is meaningless without
-- its provider, so CASCADE is the correct dependent-row semantics.
ALTER TABLE ingress_auth_configs
  DROP CONSTRAINT IF EXISTS ingress_auth_configs_provider_id_tenant_oidc_providers_id_fk;
ALTER TABLE ingress_auth_configs
  ADD CONSTRAINT ingress_auth_configs_provider_id_tenant_oidc_providers_id_fk
  FOREIGN KEY (provider_id) REFERENCES tenant_oidc_providers(id) ON DELETE CASCADE;
