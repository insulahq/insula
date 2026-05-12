-- Migration 0102: replace hostname-only unique index with hostname+path+domain composite
-- The hostname-only index was dropped in migration 0032 but the backfill tracker
-- silently marked 0032 as applied without running it on pre-tracker clusters.
-- This migration is idempotent and safe to re-run.
DROP INDEX IF EXISTS ingress_routes_hostname_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ingress_routes_hostname_path_domain_unique
  ON ingress_routes (hostname, path, domain_id);
