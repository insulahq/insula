# PostgreSQL major-version upgrade

CNPG's barman-cloud pathway (the day-to-day backup) is tied to a single PG major version — base backups taken under PG 18 cannot be restored into a PG 19 cluster. For major-version migrations the platform exposes a super_admin-only `pg_dump` pathway as the migration vehicle.

This document is the only operator-facing surface for that pathway. There is no admin-panel UI for it — the scheduled-exports UI was removed 2026-05-24 because it duplicated barman-cloud without contributing PITR.

## When to use

- PostgreSQL major-version upgrade (e.g. PG 18 → PG 19) on the platform `system-db` cluster
- One-off logical export for offline investigation (load into pgAdmin, etc.)
- Cross-environment migration (staging → laptop, etc.)

Day-to-day backups + PITR remain on barman-cloud (admin panel: `/backups/system?tab=backups`).

## Prerequisites

- `super_admin` role
- An **enabled** Remote Storage Target on `/backups/targets` (S3 or SSH/SFTP)
- The target's UUID — copy it from the Targets page

## Trigger a dump (super_admin)

```bash
JWT=...                                 # super_admin bearer token
TARGET=<remote-storage-target-uuid>     # from /backups/targets
HOST=https://admin.example.com

curl -sSL -X POST "$HOST/api/v1/system-backup/pg-dump" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "{
    \"sourceNamespace\": \"platform\",
    \"sourceCluster\":   \"system-db\",
    \"sourceDatabase\":  \"platform\",
    \"targetConfigId\":  \"$TARGET\",
    \"reason\":          \"PG 18 -> 19 upgrade\"
  }"
```

Response (202): `{ runId, status: "running", jobName, pollUrl }`. Poll `pollUrl` until `status === "succeeded"`.

## Restore a dump

`POST /api/v1/system-backup/pg-dump/runs/:id/restore-recipe` returns a copy-pasteable kubectl + pg_restore recipe. The recipe assumes you've already built the destination cluster (a fresh CNPG `Cluster` CR on the new PG major version, empty database, same `platform` role/db pair).

The recipe will `pg_restore --clean --if-exists` — it WIPES the destination database before loading. Make absolutely sure you're pointing at the new cluster, not the old one.

## What was removed

- `/backups/system?tab=backups → System Databases` UI panel
- `system_pg_dump_schedules` table (migration 0026)
- Scheduler that polled `system_pg_dump_schedules` and dispatched recurring dump Jobs

## What stays

- `POST /api/v1/system-backup/pg-dump` — on-demand trigger
- `GET  /api/v1/system-backup/pg-dump/runs` — list past runs
- `GET  /api/v1/system-backup/pg-dump/runs/:id` — inspect one run
- `GET  /api/v1/system-backup/pg-dump/runs/:id/download` — download the artifact
- `POST /api/v1/system-backup/pg-dump/runs/:id/restore-recipe` — get the restore recipe
- `POST /api/v1/system-backup/pg-dump/stream` — for piping directly into `pg_restore`

All super_admin-gated. CI guard: `scripts/ci-pg-dump-scope-check.sh`.
