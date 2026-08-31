-- Tenant-bundle restic retention: forget + prune.
--
-- ADR-048 specified that the retention sweeper's delete() path "now calls
-- `restic forget --keep-daily N --prune` ... for incremental components and
-- the legacy delete path for the config/secrets artefacts". Only the legacy
-- half ever shipped. `retention.ts` deleted the per-bundle directory
-- (`<prefix>/<bundleId>/`) and flipped the row to 'expired', but the restic
-- repos live in a SIBLING namespace (`<prefix>/restic-<component>/<tenantId>/`)
-- that nothing ever touched. No `restic forget` and no `restic prune` existed
-- anywhere in the backend.
--
-- Consequences this fixes:
--   1. Storage was never reclaimed. Expiry freed only config/secrets/db-dumps
--      (tens of KiB, full every run) while `files` and `mailboxes` — the
--      components that carry the weight — accumulated forever. Dedup made the
--      growth slow rather than explosive, which is why it went unnoticed.
--   2. The 30-day retention promise was false for tenant file and mail
--      content: the bundle read as "expired" in the UI while the data
--      remained fully present and restorable in the repo. A compliance
--      exposure, not only a cost one.
--   3. DELETE /admin/tenant-bundles/:id hard-deletes the backup_jobs row,
--      cascading backup_components and destroying the snapshot id while the
--      snapshot itself survives — genuinely orphaned.
--
-- ── Why a new table rather than columns on tenant_restic_repo_state ────────
-- The obvious home for this bookkeeping is tenant_restic_repo_state, but that
-- table's tenant_id carries `REFERENCES tenants(id) ON DELETE CASCADE`, so its
-- rows vanish when a tenant is deleted. Measured on staging: 135 recorded
-- restic snapshots across ~100 tenants, and tenant_restic_repo_state held
-- ZERO rows. Deleted tenants are precisely the largest source of orphaned
-- snapshots — their repos outlive them, because backup_jobs.tenant_id is
-- deliberately a LOOSE reference with no cascade (see the comment on that
-- column) so bundles stay expirable and recoverable after tenant deletion.
--
-- Reclamation bookkeeping therefore has to survive tenant deletion too, which
-- means the same loose-reference treatment. Anchoring it to a cascading FK
-- would make the reclaimer structurally blind to the worst case.
CREATE TABLE IF NOT EXISTS restic_repo_reclaim_state (
  -- LOOSE reference to tenants.id, matching backup_jobs.tenant_id. NO
  -- FK/CASCADE on purpose: a deleted tenant's repo still needs reclaiming.
  tenant_id                 VARCHAR(36)  NOT NULL,
  component                 VARCHAR(32)  NOT NULL,
  last_forget_at            TIMESTAMP,
  forgotten_snapshots_total BIGINT       NOT NULL DEFAULT 0,
  -- Set when a forget leaves unreferenced blobs behind. Prune is expensive, so
  -- it runs on its own rate-limited cadence rather than inline with forget;
  -- this flag is the durable hand-off (crash-safe: a pod kill between forget
  -- and prune leaves it set and the next tick prunes).
  prune_pending             BOOLEAN      NOT NULL DEFAULT FALSE,
  last_prune_at             TIMESTAMP,
  last_prune_error          TEXT,
  last_prune_duration_ms    INTEGER,
  created_at                TIMESTAMP    NOT NULL DEFAULT now(),
  updated_at                TIMESTAMP    NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, component)
);

-- The prune pass selects only pending repos, a small minority in steady state.
CREATE INDEX IF NOT EXISTS restic_repo_reclaim_state_prune_pending_idx
  ON restic_repo_reclaim_state (prune_pending)
  WHERE prune_pending;

-- Fair rotation under the per-tick repo cap: oldest-swept first.
CREATE INDEX IF NOT EXISTS restic_repo_reclaim_state_last_forget_idx
  ON restic_repo_reclaim_state (last_forget_at);

-- Operator knobs. ADR-048 called for the retention policy to be a
-- "configurable global setting"; these are that setting.
ALTER TABLE tenant_backup_v2_settings
  -- Kill switch. TRUE by default: the whole point of this migration is that
  -- reclamation was never running. Operators who want to stage the rollout can
  -- flip this off, or preview with the dry-run mode on the manual admin route.
  ADD COLUMN IF NOT EXISTS forget_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Never forget a snapshot younger than this regardless of DB state. Protects
  -- an in-flight capture whose backup_components row has not committed yet,
  -- clock skew between the platform and the backup target, and a
  -- just-restored platform DB whose rows lag the repo.
  ADD COLUMN IF NOT EXISTS forget_min_age_hours INTEGER NOT NULL DEFAULT 48,
  -- Minimum gap between prunes of the same repo.
  ADD COLUMN IF NOT EXISTS prune_min_interval_hours INTEGER NOT NULL DEFAULT 24,
  -- restic --max-repack-size. Bounds one prune pass so a large backlog
  -- converges over several nights instead of one multi-hour stall.
  ADD COLUMN IF NOT EXISTS prune_max_repack_size VARCHAR(16) DEFAULT '4G';

-- ── Purging the DB rows of backups that no longer exist ───────────────────
--
-- Once a bundle's restic snapshots are forgotten AND the expiry sweep has
-- already deleted its per-bundle directory, the backup_jobs row describes
-- something that does not exist anywhere. Operators reasonably expect a
-- removed backup to disappear from the list rather than linger as an
-- 'expired' tombstone forever.
--
-- The row cannot simply be deleted at expiry time: backup_components.sha256
-- holds the restic snapshot id, and destroying it before reclamation is
-- exactly how DELETE /admin/tenant-bundles/:id orphaned snapshots. So the
-- reclaimer stamps each component as it is actually reclaimed, and a bundle
-- row is purged only once every restic component it owns carries the stamp.
-- A bundle spanning two repos (files + mailboxes) therefore survives until
-- BOTH have been swept.
ALTER TABLE backup_components
  ADD COLUMN IF NOT EXISTS snapshot_reclaimed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS backup_components_unreclaimed_idx
  ON backup_components (backup_job_id)
  WHERE sha256 IS NOT NULL AND snapshot_reclaimed_at IS NULL;
