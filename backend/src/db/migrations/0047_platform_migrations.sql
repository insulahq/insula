-- W9 / ADR-045 — platform-migration registry.
--
-- These two tables back the CLUSTER-migration registry (runtime convergence
-- steps applied at backend startup), which is DISTINCT from the SQL schema
-- migration tracker `__platform_migrations` (double-underscore, managed by
-- db/migrate.ts). The schema tracker records which .sql files have run; THIS
-- table records which TypeScript platform-migrations (DaemonSet seeds,
-- baseline recordings, host reconciler enablement, …) have converged.
--
-- Idempotent by design: re-running this migration is a no-op (the schema
-- tracker prevents re-run anyway, but IF NOT EXISTS is belt-and-braces).

CREATE TABLE IF NOT EXISTS public.platform_migrations (
  -- Stable, order-bearing id, e.g. '0001_record_baseline'. The numeric prefix
  -- is the migration's contract position — renaming/renumbering a shipped
  -- migration is forbidden (enforced by scripts/ci-migration-idempotency.sh).
  id          TEXT PRIMARY KEY,
  -- CalVer the migration first shipped in (e.g. '2026.6.1'), for provenance.
  version     TEXT NOT NULL,
  -- sha256 of the migration's source, recorded at apply time. The runner warns
  -- (does not fail) if a later boot computes a different checksum — that means
  -- a SHIPPED migration was edited, violating the order-stable contract.
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.platform_migrations IS
  'W9 cluster-migration registry: TypeScript platform-migrations applied at backend startup. Distinct from the __platform_migrations SQL schema tracker.';

-- Versioned facts about the cluster the platform was first installed onto
-- (k3s / Calico / Longhorn / platform versions), recorded by the baseline
-- seed migration. Key/value so new baseline keys need no schema change.
CREATE TABLE IF NOT EXISTS public.platform_baselines (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  -- Where the value was read from (e.g. 'k8s-node', 'longhorn-setting',
  -- 'config') — context for an operator auditing the row. Nullable.
  source      TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.platform_baselines IS
  'Versioned cluster facts (k3s/calico/longhorn/platform) recorded by the W9 baseline platform-migration.';
