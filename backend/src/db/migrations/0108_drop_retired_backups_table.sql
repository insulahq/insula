-- Drop the retired per-resource `backups` table (2026-09-11).
--
-- It backed `GET/POST/DELETE /api/v1/tenants/{id}/backups`, an API that only
-- ever wrote its OWN rows: nothing in the platform's backup machinery — tenant
-- bundles (`backup_jobs` + `backup_components`), CNPG/barman, Longhorn
-- snapshots, mail restic — has ever inserted here. The table held ZERO rows on
-- production, staging and DEV.
--
-- That made it worse than dead: the tenant dashboard's "Backups" tile and the
-- admin tenant-detail Backups tab read it, so a tenant with 17 off-site bundles
-- was shown "0 backups" while the Backups page beside it listed all 17
-- (operator report 2026-09-11). An empty table is indistinguishable from a
-- working one that has nothing to show.
--
-- The enum types go with it — verified on production that `backups` was their
-- only consumer.
DROP TABLE IF EXISTS backups;--> statement-breakpoint
DROP TYPE IF EXISTS backup_type;--> statement-breakpoint
DROP TYPE IF EXISTS backup_status;
