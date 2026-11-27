-- Catalog repositories sync themselves once a day unless an admin turns that
-- off per repository (modules/catalog/auto-sync.ts). Existing repositories
-- start with it on.
--
-- sync_interval_minutes (default 60) was stored, accepted by the API and never
-- read: nothing synced a repository on a timer. It is dropped in this release.
-- Cost during the upgrade: API pods of the previous release name the column
-- when they read a repository (the admin Repositories page, a manual sync, the
-- startup sync) and fail until the rollout has replaced them — seconds.
ALTER TABLE catalog_repositories ADD COLUMN IF NOT EXISTS auto_sync_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE catalog_repositories DROP COLUMN IF EXISTS sync_interval_minutes;
