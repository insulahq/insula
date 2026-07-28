-- Rename the two static-site catalog entry codes (2026-07-28):
--   static-nginx  -> nginx
--   static-apache -> apache
--
-- The code is what the tenant panel pre-fills as the deployment name and what
-- `service.ts` builds the storage path from (`${type}/${code}/${name}`), so the
-- operator-facing identifier should read `nginx` / `apache`, not `static-*`.
--
-- Renamed IN PLACE rather than letting catalog-sync insert a new row: sync
-- upserts on (code, source_repo_id), so a code change would mint a fresh
-- catalog_entries.id and orphan every deployments.catalog_entry_id pointing at
-- the old row. Keeping the id makes this transparent to existing deployments —
-- their storage_path is already persisted per-row and is left untouched.
--
-- NOTE: the catalog repo's manifests must carry the new `code` too
-- (insulahq/application-catalog). Until that lands, a sync against an old
-- manifest re-inserts a `static-*` row alongside the renamed one; it
-- disappears on the next sync after the catalog change ships.
--
-- Guarded by a NOT EXISTS on the unique (code, source_repo_id) index so the
-- migration is idempotent and cannot collide with an entry that already
-- claims the target code in the same repository.

UPDATE "catalog_entries" AS ce
SET "code" = 'nginx'
WHERE ce."code" = 'static-nginx'
  AND NOT EXISTS (
    SELECT 1 FROM "catalog_entries" other
    WHERE other."code" = 'nginx'
      AND other."source_repo_id" IS NOT DISTINCT FROM ce."source_repo_id"
  );

UPDATE "catalog_entries" AS ce
SET "code" = 'apache'
WHERE ce."code" = 'static-apache'
  AND NOT EXISTS (
    SELECT 1 FROM "catalog_entries" other
    WHERE other."code" = 'apache'
      AND other."source_repo_id" IS NOT DISTINCT FROM ce."source_repo_id"
  );
