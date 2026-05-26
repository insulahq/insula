-- migration 0031 — waf_rule_exclusions tenant + route scoping (B2).
--
-- Adds nullable tenant_id + route_id columns so tenant users can manage
-- their OWN exclusions (scoped to their domains) without operator
-- intermediation. Admin-created rows stay (tenant_id, route_id) = NULL.
--
-- Invariant enforced by CHECK: either BOTH columns are set (tenant-
-- scoped row, hostnameRegex must match exactly one of the tenant's
-- ingress_routes.hostname for that route_id), or BOTH are NULL (admin-
-- scoped, hostnameRegex is operator-chosen and may match any host).
-- The mixed state (one set, one NULL) is rejected — there's no use
-- case for "tenant-owned but route-unscoped" or vice versa, and the
-- service-layer hostname-forcing logic relies on the pair being
-- consistent.
--
-- ON DELETE CASCADE on both FKs: deleting a tenant or one of its
-- routes drops the exclusion automatically. That's the desired
-- behaviour — the rule the exclusion was for no longer matters once
-- the route is gone.
--
-- New index on (tenant_id, route_id) covers the per-route listing
-- query without scanning the full table.

ALTER TABLE waf_rule_exclusions
  ADD COLUMN tenant_id VARCHAR(36) REFERENCES tenants(id) ON DELETE CASCADE,
  ADD COLUMN route_id  VARCHAR(36) REFERENCES ingress_routes(id) ON DELETE CASCADE;

ALTER TABLE waf_rule_exclusions
  ADD CONSTRAINT waf_rule_exclusions_tenant_route_pair_chk
    CHECK (
      (tenant_id IS NULL AND route_id IS NULL)
      OR (tenant_id IS NOT NULL AND route_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS waf_rule_exclusions_tenant_route_idx
  ON waf_rule_exclusions (tenant_id, route_id)
  WHERE tenant_id IS NOT NULL;
