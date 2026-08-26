# Legacy backup path — RETIRED 2026-08-26

The pre-shim "target-activate" backup model is fully retired (operator
decision 2026-08-26). What it was: the admin-panel **Activate** button
wrote raw target credentials into the `backup-credentials` /
`longhorn-backup-credentials` Secrets, pointed Longhorn's BackupTarget
at the target, and unsuspended the DR CronJobs. The 3-class
backup-rclone-shim assignments (R-X20) replaced it as the only backup
routing.

Removed in the retirement:

| Thing | Fate | Replacement |
|---|---|---|
| `POST /admin/backup-configs/:id/activate` + `/deactivate` routes | deleted | shim class assignments (`PUT /admin/backup-rclone-shim/assignments/:class`) |
| `GET /:id/backups` + `POST /:id/backup-now` (Longhorn volume backups) | deleted | tenant bundles / snapshots (Longhorn volume-level backups removed 2026-08-26) |
| `longhorn-reconciler.ts` (Secret + BackupTarget writer, CronJob label-toggle) | deleted | `backup-rclone-shim/dr-cronjobs.ts` owns `backup-credentials` + suspend flags |
| `etcd-snapshot-cronjob.yaml` | deleted | `etcd-snap-via-shim-cronjob.yaml` (R-X7) |
| `postgres-dump-cronjob.yaml` | deleted | CNPG base backups + WAL via barman plugin (R-X6) |
| the `hostpath-snapshot` CronJob manifest | deleted (was already inactive) | per-Job rclone streaming pipeline |
| `backup_configurations.active` rows | cleared by migration 0090 | — (column drop is a follow-up schema cleanup) |
| Admin-panel Activate/Deactivate buttons + "Active Backup Target" card | deleted | Backups → per-class *Targets, Schedules & Retention* |

Still present, shim-bridged (see `dr-cronjobs.ts`):

| File | Subsystem | Fed by |
|---|---|---|
| `cluster-state-cronjob.yaml` | cluster-state dump | shim bridge (`backup-credentials` → shim S3, `system/dr/…`) |
| `secrets-backup-cronjob.yaml` | age-encrypted secrets bundle | shim bridge |
| `backup-audit-cronjob.yaml` | DR audit/inventory | unsuspend only — read-only, no upstream IO |

### CI guard: no NEW legacy uses

`scripts/ci-backup-rclone-shim-check.sh` invariant 16 rejects **new**
files that reference the `backup-credentials` Secret or use
`aws s3 cp`/`sync` outside the three bridged CronJobs above — every new
backup pipeline must go through the shim. The guard stays permanently.
