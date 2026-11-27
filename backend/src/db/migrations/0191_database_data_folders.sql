-- deployments: where a standalone database instance's data is (roadmap R48).
--
-- data_detached_path / data_detached_at: set while the tenant has detached the
-- instance's data for raw access — the folder it was moved to (under
-- kept-databases/). The instance cannot start until the data is attached again.
-- storage_relocated_from: the storage path an instance had before its data was
-- moved into the protected database/ folder, so a bundle taken before the
-- move still finds its pre-dumps there.
--
-- Additive and replay-safe (IF NOT EXISTS) for the non-transactional runner.

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS data_detached_path varchar(500);
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS data_detached_at timestamptz;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS storage_relocated_from varchar(500);
