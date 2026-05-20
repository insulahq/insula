# Legacy backup CronJobs — deprecated path

> **Status:** Active during the R-X migration window. Will move to
> `k8s/base/backup/legacy/` once the shim is proven on staging +
> R-X9 ↔ R-X11 ↔ R-X12 close the loop.

The following CronJobs predate the universal backup-rclone-shim
(R-X1 through R-X14). They use the legacy `backup-credentials`
Secret (Phase 2 ADR-032) which is reconciled from the active
admin-panel "backup target" rather than the new 3-class shim
binding.

| File | Subsystem | Replaced by |
|---|---|---|
| `etcd-snapshot-cronjob.yaml` | `SYSTEM.etcd` | `etcd-snap-via-shim-cronjob.yaml` (R-X7) |
| `postgres-dump-cronjob.yaml` | `SYSTEM.postgres` | CNPG plugin-barman-cloud via shim (R-X6) |
| `cluster-state-cronjob.yaml` | `SYSTEM.secrets-bundle` | R-X9 secrets-bundle rclone-push (planned) |
| `secrets-backup-cronjob.yaml` | `SYSTEM.secrets-bundle` | R-X9 secrets-bundle rclone-push (planned) |
| `backup-audit-cronjob.yaml` | DR audit/inventory | unchanged — read-only, no upstream IO |

### Why "deprecated but not removed"

Three reasons the legacy CronJobs ship alongside the R-X path
during the transition window:

1. **Operator coexistence**: a cluster may have the legacy
   `backup-credentials` Secret bound to one target (operator-
   configured pre-R-X) AND the new 3-class shim assignments set
   to a different target. Removing legacy would force an
   immediate cutover at upgrade time — too risky for a backup
   subsystem.
2. **Rollback path**: if the shim has a regression that breaks
   uploads, operators can pause the shim and re-enable the
   legacy CronJob with one `kubectl patch` per file. R-X14 perf
   benchmark validates the shim against the legacy path's
   throughput.
3. **Audit-only CronJobs stay**: `backup-audit-cronjob.yaml`
   doesn't write upstream — it builds a per-PVC inventory for
   operator dashboards. Migrating that to the shim has no
   benefit.

### CI guard: no NEW legacy uses

`scripts/ci-backup-rclone-shim-check.sh` invariant 16 rejects
**new** code that:

- Adds `backup-credentials` Secret refs (envFrom or secretKeyRef)
  outside the files listed above + legacy mail paths.
- Adds `aws s3 cp` / `aws s3 sync` CLI usage to NEW CronJobs.
- Adds rclone-without-shim usage (i.e. rclone configs that name
  an upstream backend directly instead of `:s3:<bucket>` against
  the shim endpoint).

The guard is intentionally allowlist-based — the existing files
remain, but new uses of the legacy patterns are blocked at PR
time.

### Archival schedule

- **2026-Q3**: R-X12 E2E DR drill passes on staging for 2 weeks
  → move legacy CronJobs to `k8s/base/backup/legacy/`.
- **2026-Q4**: R-X14 perf benchmark + 2 production-equivalent
  staging cycles → delete the legacy directory entirely.

The CI guard remains in place after archival to prevent
re-introduction.
