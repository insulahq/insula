-- Multi-host serving: one runtime pod answering several ingress routes, each
-- from its own folder on the tenant PVC.
--
-- Three columns, one job each:
--
--  catalog_entries.multihost — the CAPABILITY, copied verbatim from the
--    catalog manifest's `multihost` block (flavour, roots, include dir,
--    validate/reload argv). NULL means the entry cannot do this. Capability is
--    declared by the catalog, never inferred from web_server: an entry whose
--    image has no include directory must not silently advertise multi-host.
--
--  deployments.multihost_enabled — the OPERATOR's choice for one deployment.
--    Deliberately a column and not an entry in `configuration`: env changes
--    flow through the pod template and restart the pod, while this flag only
--    changes generated ConfigMap content delivered by a graceful reload. The
--    one exception is the toggle itself, which adds/removes the pod's mounts.
--
--  ingress_routes.site_folder — WHICH folder this hostname serves, as a path
--    relative to the tenant PVC ROOT (same convention as
--    deployments.extra_mounts.folder), so a route may serve any folder the
--    tenant can see in the file manager, not only a child of the deployment's
--    own storage_path. NULL keeps today's behaviour: the route is served by
--    the stock single-site vhost from the deployment's document root.

ALTER TABLE catalog_entries
  ADD COLUMN IF NOT EXISTS multihost jsonb;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS multihost_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE ingress_routes
  ADD COLUMN IF NOT EXISTS site_folder varchar(500);

-- A route may only name a folder when it points at a deployment. A
-- private_worker or redirect-only route has no container to serve it from, so
-- a folder there is silently meaningless — reject it at the storage layer
-- rather than let it sit in the row looking effective.
ALTER TABLE ingress_routes
  DROP CONSTRAINT IF EXISTS ingress_routes_site_folder_needs_deployment;
ALTER TABLE ingress_routes
  ADD CONSTRAINT ingress_routes_site_folder_needs_deployment
  CHECK (site_folder IS NULL OR deployment_id IS NOT NULL);
