-- Make the image-audit sentinel row actually unique, and collapse the
-- duplicates that accumulated because it never was.
--
-- The digest of a running custom-container image is recorded in two steps: a
-- NULL "sentinel" row when the pod is observed but has not reported an imageID
-- yet (it is still pulling), then an UPDATE that fills the digest in once the
-- kubelet reports it.
--
-- `image-audit.ts` documented the sentinel insert as idempotent, "rejected by
-- the NULLS NOT DISTINCT unique constraint". The index was created WITHOUT that
-- clause, and Postgres treats NULLs as distinct by default — so every redeploy
-- appended another sentinel instead of being rejected. One production
-- deployment had accumulated 64 of them.
--
-- That alone would only waste rows. What broke the feature is the fill-in step:
--
--   UPDATE custom_deployment_image_audit
--      SET resolved_digest = $1
--    WHERE deployment_id = $2 AND resolved_digest IS NULL   -- no LIMIT
--
-- With N sentinels it tries to set them ALL to the same digest, which violates
-- UNIQUE (deployment_id, resolved_digest) as soon as N > 1. Verified against
-- production:
--
--   ERROR: duplicate key value violates unique constraint
--          "custom_deployment_image_audit_deployment_digest_unique"
--
-- The reconciler calls the recorder as `.catch(() => 0)`, so the throw was
-- swallowed every 15 seconds and the digest was never persisted: 64 rows, 0
-- with a digest. `getRunningDigest` filters on `resolved_digest IS NOT NULL`,
-- so it always returned null, and the update check for a moving tag (`:latest`)
-- can only answer "unknown" without it — never "update available", never "up to
-- date". Reported four times.
--
-- This migration fixes the shape. The no-LIMIT UPDATE is fixed in code.

-- 1. Collapse existing duplicate sentinels to one per deployment. Keep the
--    newest; it is the only one the recorder would have filled in anyway.
DELETE FROM custom_deployment_image_audit a
 USING custom_deployment_image_audit b
 WHERE a.resolved_digest IS NULL
   AND b.resolved_digest IS NULL
   AND a.deployment_id = b.deployment_id
   AND (a.pulled_at, a.id) < (b.pulled_at, b.id);

-- 2. Recreate the unique index with the semantics the code always assumed, so
--    a second sentinel for the same deployment is rejected rather than
--    appended. Requires PostgreSQL 15+; the platform ships 18 (CNPG).
DROP INDEX IF EXISTS custom_deployment_image_audit_deployment_digest_unique;

CREATE UNIQUE INDEX custom_deployment_image_audit_deployment_digest_unique
    ON custom_deployment_image_audit (deployment_id, resolved_digest)
    NULLS NOT DISTINCT;
