-- Drop the route sign-in settings oauth2-proxy never used.
--
-- tenant_oidc_providers.auth_method / response_type offered client_secret_basic
-- vs client_secret_post and code vs id_token, but nothing passed either to
-- oauth2-proxy: it detects the token endpoint's auth style by itself and
-- supports only the authorization-code flow. ingress_auth_configs.scopes_override
-- was a per-route scope list, but one oauth2-proxy serves every route of a
-- tenant and can hold one scope list, so only the first route's ever applied;
-- the provider's scopes are the scopes now.
--
-- Dropped in the SAME release that stopped reading them, by operator
-- decision (not the expand/contract split of 0046/0150). The cost, accepted:
-- during the upgrade the previous release's API pods still serve until the
-- rollout replaces them, and they SELECT these columns by name on every route
-- sign-in and provider read, which fail with 42703 for that window (minutes).
--
-- Tenant bundles taken before the drop still carry the columns in their
-- config dump: RETIRED_BUNDLE_COLUMNS (backup-restore/executors/_shared.ts)
-- skips them on restore — keep those entries while such bundles can be
-- restored.
--
-- The header defaults follow the API's: the Authorization header and the
-- tokens are no longer passed to the app unless asked for, and a session is
-- not re-checked with the provider before its cookie expires. Existing rows
-- keep the values they were saved with.
--
-- IF EXISTS makes the statements replay-safe under the non-transactional
-- runner.
ALTER TABLE "tenant_oidc_providers"
  DROP COLUMN IF EXISTS "auth_method",
  DROP COLUMN IF EXISTS "response_type";

ALTER TABLE "ingress_auth_configs"
  DROP COLUMN IF EXISTS "scopes_override";

ALTER TABLE "ingress_auth_configs"
  ALTER COLUMN "pass_authorization_header" SET DEFAULT false,
  ALTER COLUMN "pass_access_token" SET DEFAULT false,
  ALTER COLUMN "pass_id_token" SET DEFAULT false,
  ALTER COLUMN "cookie_refresh_seconds" SET DEFAULT 0;
