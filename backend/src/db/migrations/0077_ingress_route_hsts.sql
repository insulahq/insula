-- Per-route HSTS (Strict-Transport-Security) settings (2026-07-28).
--
-- HSTS belongs on the ingress route, not in the workload image: the catalog
-- runtimes (nginx/apache) deliberately emit no security headers of their own,
-- and a tenant can swap runtimes without losing the policy. This puts it beside
-- the other per-route edge settings (force_https, ip_allowlist, rate_limit_*,
-- waf_*), reconciled into a Traefik `headers` Middleware.
--
-- DEFAULT OFF, deliberately. HSTS is sticky — once a browser has seen the
-- header it refuses plain HTTP for max_age seconds and there is no server-side
-- way to recall it. Enabling it implicitly for existing routes could hard-break
-- any tenant whose site is not fully HTTPS-ready. Operators opt in per route.
--
-- max_age default 31536000 (1 year) is the value the preload list requires; it
-- is only ever sent when hsts_enabled = 1.

ALTER TABLE "ingress_routes"
  ADD COLUMN IF NOT EXISTS "hsts_enabled" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "hsts_max_age" integer NOT NULL DEFAULT 31536000,
  ADD COLUMN IF NOT EXISTS "hsts_include_subdomains" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "hsts_preload" integer NOT NULL DEFAULT 0;

-- Guard the preload contract at the storage layer too: the browser preload list
-- only accepts max-age >= 1 year WITH includeSubDomains. A row that violates it
-- would advertise a policy no browser will honour while still locking clients
-- out of plain HTTP.
ALTER TABLE "ingress_routes"
  DROP CONSTRAINT IF EXISTS "ingress_routes_hsts_preload_check";
ALTER TABLE "ingress_routes"
  ADD CONSTRAINT "ingress_routes_hsts_preload_check"
  CHECK (
    "hsts_preload" = 0
    OR ("hsts_include_subdomains" = 1 AND "hsts_max_age" >= 31536000)
  );
