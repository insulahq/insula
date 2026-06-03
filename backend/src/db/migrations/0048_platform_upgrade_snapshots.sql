-- W16 / ADR-045 — per-upgrade rollback manifest.
--
-- One row is captured BEFORE each APPLIED platform upgrade (never on a dry-run):
-- the Flux source ref to roll BACK to, plus the Longhorn rescue snapshots taken
-- for the destructive data-restore path. `platform-ops rollback` / the rollback
-- endpoint read the most recent `captured` row to undo an upgrade.
--
-- Idempotent: re-running is a no-op (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.platform_upgrade_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Installed version before the upgrade (nullable — unknown on a fresh boot).
  from_version    TEXT,
  -- Target version the upgrade re-pinned to.
  to_version      TEXT NOT NULL,
  -- The Flux GitRepository that was re-pinned (resolved from the Kustomization).
  git_repository  TEXT NOT NULL,
  -- The ref to roll BACK to (the source's ref before the upgrade): {tag|branch|commit}.
  previous_ref    JSONB NOT NULL,
  -- Longhorn rescue snapshots for the data-restore path:
  --   [{ volumeName, namespace, pvcName, snapshotName }]
  rescue_snapshots JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- captured | rolled-back (constrained so a hand-edited row can't slip past the
  -- runRollback already-rolled-back guard with an unexpected value)
  status          TEXT NOT NULL DEFAULT 'captured' CHECK (status IN ('captured', 'rolled-back')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The rollback reader wants the most recent captured row fast.
CREATE INDEX IF NOT EXISTS platform_upgrade_snapshots_created_idx
  ON public.platform_upgrade_snapshots (created_at DESC);

COMMENT ON TABLE public.platform_upgrade_snapshots IS
  'W16 per-upgrade rollback manifest: the Flux ref to roll back to + Longhorn rescue snapshots, captured before each applied upgrade.';
