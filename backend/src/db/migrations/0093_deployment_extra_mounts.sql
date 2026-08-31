-- Tenant-defined extra volume mounts per deployment.
--
-- Shape (validated by extraMountsSchema in @insula/api-contracts):
--   [{ "folder": "shared-assets", "mount_path": "/var/www/html/media",
--      "read_only": false }, ...]
--
-- `folder` is relative to the TENANT PVC ROOT, not the deployment's own
-- storage_path, so two deployments naming the same folder share it. That also
-- means these folders survive a deployment delete-with-data, which only clears
-- the deployment's own storage_path subtree.
--
-- NULL and '[]' both mean "no extra mounts"; the code normalises to an empty
-- array on read, so existing rows need no backfill.
ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS extra_mounts jsonb;
