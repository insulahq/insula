-- users: make the OIDC identity key PANEL-SCOPED.
--
-- `users_oidc_unique` was UNIQUE (oidc_issuer, oidc_subject) across the whole
-- table. Two consequences, both user-visible:
--
--  1. One IdP identity could be linked to exactly ONE user row platform-wide,
--     so the same person could not hold both an admin-panel and a tenant-panel
--     account backed by the same SSO login.
--
--  2. findOrCreateOidcUser looks up by (issuer, subject) FIRST and — unlike the
--     email lookup right after it — did not filter by panel. So a tenant-panel
--     sign-in resolved to whichever account linked that identity first, admin
--     included, and routes.ts mints the JWT from it (`panel: user.panel`,
--     `tenantId: user.tenantId`). The tenant panel therefore evaluated exactly
--     one account instead of the tenant's own.
--
-- Widening a unique key is a relaxation: every row that satisfied the old
-- 2-column constraint still satisfies the 3-column one, so this cannot fail on
-- existing data and needs no backfill. Postgres also treats NULLs as distinct,
-- so the many users with no OIDC linkage are unaffected either way.

DROP INDEX IF EXISTS users_oidc_unique;
CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_unique
  ON users (oidc_issuer, oidc_subject, panel);
