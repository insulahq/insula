-- CPU cores stop being a plan or tenant parameter (ADR-062, final step).
--
-- Under CPU shares a tenant's CPU is its TIER (the share it gets under
-- contention) and its BURST CEILING (how far one application may go). The
-- plan's `cpu_limit` ("cores") was read in only two places: by tenants still
-- on the old reservation model, which are now moved to shares automatically
-- (cpu-migration/auto-migrate.ts), and as the fallback a ceiling was DERIVED
-- from — `max(1, cores x 2)` — when a plan or tenant set no ceiling.
--
-- This writes that derived ceiling down, so the fallback can go without any
-- tenant's ceiling moving. Tenants first: a tenant's own cores override only
-- decided its ceiling when its plan had none, so it must be read before the
-- plan is filled in.
--
-- Idempotent. Rows that already state a ceiling are left as they are.

UPDATE "tenants" t
   SET "cpu_burst_cores_override" = GREATEST(1, ROUND(t."cpu_limit_override" * 2, 2))
 WHERE t."cpu_limit_override" IS NOT NULL
   AND t."cpu_burst_cores_override" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "hosting_plans" p
      WHERE p."id" = t."plan_id" AND p."cpu_burst_cores" IS NOT NULL
   );

UPDATE "hosting_plans"
   SET "cpu_burst_cores" = GREATEST(1, ROUND("cpu_limit" * 2, 2))
 WHERE "cpu_burst_cores" IS NULL;

-- Every plan states a ceiling from here on; one written without (an import, a
-- test fixture) gets the floor the derivation always had.
ALTER TABLE "hosting_plans" ALTER COLUMN "cpu_burst_cores" SET DEFAULT 1;
-- safety-reviewed: the UPDATE above fills every NULL `cpu_burst_cores` in the
-- same migration (GREATEST(1, …) of a NOT NULL `cpu_limit` is never NULL),
-- so no existing row can fail this. During the rollout an OLD backend pod
-- still writes an explicit NULL for a plan saved with a blank ceiling. That
-- one save is refused (a visible error, nothing lost) until the pod is
-- replaced — the new pods require a ceiling.
ALTER TABLE "hosting_plans" ALTER COLUMN "cpu_burst_cores" SET NOT NULL;
