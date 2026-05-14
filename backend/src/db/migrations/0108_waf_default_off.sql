-- 0108_waf_default_off.sql
-- Flip WAF default to OFF for new ingress routes.
--
-- Why: the Traefik migration introduces the Coraza-plugin WAF Middleware.
-- Until tenants have explicitly opted into WAF, false positives on
-- application-specific URLs (admin panels, file managers, custom APIs)
-- block legitimate traffic. Flipping the default to off means tenants
-- get a working route immediately; they opt in to WAF when they want
-- the OWASP CRS protection.
--
-- This only changes the SQL column DEFAULT. Existing rows are not
-- modified — tenants who explicitly enabled WAF keep their setting,
-- tenants on the legacy migration-0029 default (1) keep WAF on too
-- until they toggle it off in the admin panel. The TS schema in
-- backend/src/db/schema.ts has shipped `.default(0)` for some time
-- already, so Drizzle-mediated inserts have been writing 0 — this
-- migration makes raw-SQL inserts match.

ALTER TABLE ingress_routes ALTER COLUMN waf_enabled SET DEFAULT 0;
ALTER TABLE ingress_routes ALTER COLUMN waf_owasp_crs SET DEFAULT 0;
