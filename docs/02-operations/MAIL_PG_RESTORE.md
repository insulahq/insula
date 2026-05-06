# Mail-PG Restore Runbook

> **Audience**: operators recovering from a Stalwart data-loss event,
> debugging credential drift, or running a DR drill.

## Why this document exists

Stalwart 0.16 stores per-mailbox credentials as one-way bcrypt hashes
inside its own `mail-pg` PostgreSQL database. The platform-side
`mailboxes.password_hash` column also holds bcrypt — but Stalwart's
JMAP `Account/credentials` field **does not accept pre-hashed
credentials**. We empirically verified on 2026-05-06 that any bcrypt
string passed via `Account/credentials/0/secret` (with or without
RFC-2307 `{BCRYPT}` prefix) is treated as plaintext and re-hashed.

This means: **after `mail-pg` is wiped, every user's plaintext
password is unrecoverable from the platform DB alone**. The only
non-rotation recovery path is `mail-pg` backup + restore.

CNPG's scheduled `Backup` CRs are configured for `mail-pg`
(off-site S3, 30-day retention). This runbook walks through using
them.

## What's protecting you

```
$ kubectl get scheduledbackup.postgresql.cnpg.io -n mail
NAME                    AGE    CLUSTER   LAST BACKUP
mail-pg-daily           2d2h   mail-pg   10h
mail-pg-system-backup   99m    mail-pg   99m
```

| | mail-pg | platform/postgres |
| --- | --- | --- |
| Schedule | daily 03:15 UTC + system-backup hourly | system-backup hourly |
| Destination | `s3://k8s-staging/.../wal-archive/mail-mail-pg` | `s3://k8s-staging/.../wal-archive/platform-postgres` |
| Retention | 30 days | 30 days |
| Compression | gzip (data + WAL) | gzip |
| Target | prefer-standby | prefer-standby |

Each completed `Backup` CR plus the WAL archive lets you restore to
any point in the retention window (PITR — point-in-time recovery).

## What can NOT be recovered from this

- **Stalwart blob store on disk** — when the BlobStore type is
  `Default` or `FileSystem`, message bodies are stored OUTSIDE
  `mail-pg` and outside the CNPG backup. If you've configured S3
  blob storage (recommended for HA), bodies are recoverable from
  the S3 bucket independently.
- **Active in-flight SMTP queue** — messages that were in Stalwart's
  delivery queue at backup time will be lost.
- **Anything written between the most recent successful backup and
  the wipe** — the WAL archive narrows this window, but if no WAL
  shipping happened in the last N seconds, those N seconds are gone.

## Daily-driver: use the wrapper script

Always go through `scripts/reset-mail-pg.sh`. It refuses to run
without explicit flags, audits backup health before destructive
actions, and renders the right `bootstrap.recovery` Cluster CR
shape for you.

```sh
# What backups do I have?
./scripts/reset-mail-pg.sh --list-backups

# Restore from a specific backup (the recovery path)
./scripts/reset-mail-pg.sh --restore-from-backup mail-pg-daily-20260506031500

# If a cluster already exists (e.g. corrupted state) and you want to
# replace it with a restored copy, add --replace.
./scripts/reset-mail-pg.sh --restore-from-backup <name> --replace

# Nuclear: delete cluster + PVCs (test bench / true reset only).
# Requires typing DELETE-MAIL-PG to confirm.
./scripts/reset-mail-pg.sh --really-delete-mail-pg
```

**NEVER run `kubectl delete cluster.postgresql.cnpg.io mail-pg`
directly.** It bypasses backup-audit + confirmation. This is exactly
the mistake that prompted this runbook to exist (2026-05-06: an
operator wiped staging mail-pg to clean up rotation-test churn,
expecting CNPG to recreate clean — and lost every test mailbox's
credentials in the process, when restore from the existing backup
would have brought them back intact).

## Scenarios

### Scenario A — "I need to restore the latest known-good state"

The most common case: data is corrupted or wiped, you want to roll
back to the latest backup.

```sh
# 1. List backups, find the latest 'completed' one.
./scripts/reset-mail-pg.sh --list-backups

# Sample output:
#   mail-pg-system-backup-20260506115617   99m   mail-pg   barmanObjectStore   completed
#   mail-pg-daily-20260506031500           10h   mail-pg   barmanObjectStore   completed
#   mail-pg-daily-20260505031500           34h   mail-pg   barmanObjectStore   failed   ← skip

# 2. Run the restore. If a cluster currently exists (corrupted or empty),
# add --replace to overwrite it.
./scripts/reset-mail-pg.sh \
  --restore-from-backup mail-pg-system-backup-20260506115617 \
  --replace

# 3. CNPG will spin up a new cluster with the restored data. Watch:
kubectl get cluster.postgresql.cnpg.io -n mail mail-pg -w

# Expected progression:
#   STATUS: Setting up primary
#   STATUS: Waiting for the instances to become active
#   STATUS: Cluster in healthy state   ← done

# 4. Roll Stalwart so its connection pool reconnects to the restored DB:
kubectl rollout restart deployment -n mail stalwart-mail-v016

# 5. Verify Stalwart sees the restored data via the cli:
kubectl exec -n platform admin-panel-... -- curl -s -u admin:<PW> \
  http://stalwart-mgmt-v016.mail.svc.cluster.local:8080/jmap/session \
  | jq .accounts
```

### Scenario B — "I need point-in-time recovery (PITR)"

Use this when you know roughly when corruption happened and want to
restore to a moment before that. CNPG uses the WAL archive to replay
to the target time.

The wrapper script doesn't have a PITR shortcut — apply the Cluster
CR by hand:

```sh
# 1. Pick a base backup that PRECEDES your target time.
./scripts/reset-mail-pg.sh --list-backups

# 2. Delete the existing cluster + PVCs (the script does this for you
# in restore mode; for PITR we do it explicitly).
kubectl delete cluster.postgresql.cnpg.io -n mail mail-pg --wait=true
kubectl delete pvc -n mail -l cnpg.io/cluster=mail-pg --wait=true

# 3. Apply a Cluster CR with both `backup` (the base) and
# `recoveryTarget.targetTime` (the PITR target).
cat <<EOF | kubectl apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: mail-pg
  namespace: mail
  annotations:
    kustomize.toolkit.fluxcd.io/ssa: merge
spec:
  imageName: ghcr.io/cloudnative-pg/postgresql:16.9
  bootstrap:
    recovery:
      backup:
        name: mail-pg-daily-20260506031500
      recoveryTarget:
        # ISO 8601 UTC. Restore replays WAL up to (but not including)
        # this moment. Choose 1-5 minutes BEFORE the corruption time.
        targetTime: "2026-05-06T11:55:00.000+00:00"
  storage:
    size: 5Gi
    storageClass: longhorn-system-local
  affinity:
    nodeSelector:
      platform.example.test/node-role: server
    tolerations:
      - key: platform.example.test/server-only
        operator: Exists
        effect: NoSchedule
EOF

# 4. Watch as before; roll Stalwart when Ready.
```

### Scenario C — "Backup destination is unreachable / corrupted"

Your backups are configured but the S3 bucket is gone, the credentials
are wrong, or the WAL archive has a gap.

1. **Check backup health first** before any destructive action:
   ```sh
   kubectl get backup.postgresql.cnpg.io -n mail \
     -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.phase}{"  "}{.status.error}{"\n"}{end}'
   ```
2. If recent backups have `phase: failed`, fix the upstream cause
   (S3 credentials, network, bucket policy) before considering any
   restore. See [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) for the
   `backup-credentials` Secret structure.
3. If you genuinely have NO recent backup, you're in the worst-case
   scenario:
   - Stalwart accepts new account creates as plaintext, but the
     existing platform-DB bcrypt hashes are useless to Stalwart.
   - Recovery means: every user resets their password.
   - The "Mail Subsystem Drift" admin UI (Phase 2A.4 — TBD) will
     surface orphaned mailboxes for batch password-reset emails.

### Scenario D — "I'm running a DR drill"

Simulate a wipe + restore in staging without forcing every user
through a real outage:

```sh
# 1. Capture pre-state (whatever sentinel you want to verify came back)
SENTINEL_PW=$(openssl rand -base64 24)
# Create a probe mailbox in Stalwart with this password (via JMAP or UI)

# 2. Force a backup so we have a fresh restore point INCLUDING the sentinel
kubectl annotate scheduledbackup.postgresql.cnpg.io -n mail \
  mail-pg-system-backup \
  cnpg.io/forceImmediateBackup="$(date +%s)" --overwrite
# Wait for a new Backup CR with phase=completed.

# 3. Wipe — but use the script.
./scripts/reset-mail-pg.sh --really-delete-mail-pg

# 4. Restore.
LATEST=$(kubectl get backup.postgresql.cnpg.io -n mail \
  --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1].metadata.name}')
./scripts/reset-mail-pg.sh --restore-from-backup "$LATEST"

# 5. Verify the sentinel still authenticates.
# IMAP login or JMAP /session probe with $SENTINEL_PW should return 200.
```

## Common pitfalls

### "I deleted the cluster, the new one came back, but the data is empty"

You hit the bug that birthed this runbook. CNPG's default `bootstrap`
is `initdb` — when the Cluster CR has no recovery section, it
**recreates an empty database**. Your old PVCs were already deleted
along with the cluster, so the data is gone unless you have a backup.

The fix from here: identify the most recent good Backup CR, and apply
a new Cluster CR with `bootstrap.recovery.backup.name` pointing at it
(use the wrapper script's `--restore-from-backup` mode).

### "Cluster won't come back after restore — stuck in Setting up primary"

Common causes:
- The named Backup is too old and the WAL archive has a gap.
  Pick a more recent Backup.
- The `backup-credentials` Secret in `mail` namespace is missing
  or has wrong S3 credentials. CNPG needs them to fetch from S3
  during restore.
  ```sh
  kubectl get secret -n mail backup-credentials -o jsonpath='{.data}' | jq keys
  # Expected: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINTS,
  #           S3_BUCKET, S3_REGION (at minimum).
  ```
- The barman-cloud destinationPath in the Cluster CR doesn't match
  where the Backup was actually written. Check the original
  `spec.backup.barmanObjectStore.destinationPath`.

### "Restore worked but Stalwart still shows old/empty data"

Stalwart's pods may have cached connection state to the OLD
`mail-pg` Service VIP. Roll the Deployment:

```sh
kubectl rollout restart deployment -n mail stalwart-mail-v016
```

If accounts ARE in mail-pg post-restore but Stalwart still 404s on
them, check that Stalwart restarted cleanly:

```sh
kubectl logs -n mail -l app=stalwart-mail-v016 --tail=50
```

### "I need to roll back the restore"

You can't, in the literal sense — once `--replace` deleted the
existing cluster, the pre-restore data is gone. Best you can do
is restore from a different (earlier or later) backup. Always
double-check the `--list-backups` output before confirming.

## Test the procedure regularly

DR drills uncover gaps. Add `mail-pg` to your existing DR drill
schedule. The `--really-delete-mail-pg` + `--restore-from-backup`
sequence is reproducible enough to run every quarter on staging.

The drill log lives in [DR_DRILL_LOG.md](DR_DRILL_LOG.md) — append
each run with: date, who ran it, time-to-recover, any gaps found.

## Related documentation

- [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) — backup architecture overview
- [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) — cluster-level DR
- [DR_DRILL_LOG.md](DR_DRILL_LOG.md) — historical drill outcomes
- [TENANT_BACKUP.md](TENANT_BACKUP.md) — tenant data backup (separate system)
