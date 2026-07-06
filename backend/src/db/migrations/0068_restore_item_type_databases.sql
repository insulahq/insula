-- 0068: restore_item_type gains 'databases-by-id' (gap G4)
--
-- The restore-cart executor set adds `databases-by-id`, which recovers a
-- tenant's add-on database(s) from the per-database `.sql` dump captured
-- inside the files snapshot (databases/<deploymentName>/predump-<db>-<bundleId>.sql,
-- ADR-047). The restore_items.type column is the `restore_item_type` enum
-- (created in migration 0000); without this value the INSERT for a
-- databases-by-id cart item is rejected.
--
-- Migration runner note: backend/src/db/migrate.ts runs each statement in
-- this file via its own db.execute call (autocommit), so the ALTER TYPE
-- ADD VALUE below executes in its own implicit transaction and is therefore
-- allowed by Postgres. DO NOT wrap this file in an explicit BEGIN/COMMIT.
--
-- Idempotent: ADD VALUE IF NOT EXISTS — safe to re-run.

ALTER TYPE "restore_item_type" ADD VALUE IF NOT EXISTS 'databases-by-id';
