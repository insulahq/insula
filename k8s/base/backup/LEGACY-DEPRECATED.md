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

### Second pass — `backup-audit-cronjob.yaml` deleted 2026-09-03

The audit outlived the thing it audited. It flagged every Longhorn PVC missing
`recurring-job-group.longhorn.io/default=enabled` and told the operator
*"Backups will skip it"* — but volume-level Longhorn backups went away in the
2026-08-26 retirement above. Since then that label has governed only the local
`hourly-snap` and `daily-fstrim` RecurringJobs, so the warning named a
mechanism that no longer existed.

It could not have done its stated job in any case. Its filter was
`select(.spec.storageClassName=="longhorn")`, and there are seven Longhorn
storage classes on a real cluster — tenant volumes are `longhorn-tenant`,
platform volumes `longhorn-system-local`. **The audit was structurally unable
to see a single tenant PVC**, which is precisely the case its own header said
it existed to catch. On production the only PVC it could ever match was
`crowdsec/crowdsec-data`, an infra cache that wants no snapshots, so the job
exited non-zero every night for 21 days and had never once succeeded
(`lastSuccessfulTime` empty).

Removed with it: `scripts/apply-backup-labels.sh` (same wrong filter, same
retired premise) and the `platform-backup-audit` entry in
`BRIDGED_DR_CRONJOBS`. Backup *coverage* is the 3-class shim pipeline's own
concern and is surfaced by `insula.host/backup-health-watch`; snapshot-group
membership is set by `k8s-provisioner` when a tenant PVC is created.

### CI guard: no NEW legacy uses

`scripts/ci-backup-rclone-shim-check.sh` invariant 16 rejects **new**
files that reference the `backup-credentials` Secret or use
`aws s3 cp`/`sync` outside the three bridged CronJobs above — every new
backup pipeline must go through the shim. The guard stays permanently.
