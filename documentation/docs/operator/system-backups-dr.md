---
verified: 2026.6.7
---

# System backups & disaster recovery

Tenant backups protect your customers' data. **System backups** protect the
platform itself — the cluster state, the platform database, and the secrets that
make everything else decryptable. This is what stands between you and a
from-scratch rebuild when a cluster is lost.

You manage this from **Backups → System** and **Backups → Disaster Recovery**.

## What gets backed up at the system level

| Artefact | What it is |
|---|---|
| **System snapshots** | Block-level (Longhorn) snapshots of the platform PVCs — fast in-cluster recovery |
| **Postgres base + WAL** | The platform database, with write-ahead logs for point-in-time recovery |
| **etcd snapshots** | The Kubernetes cluster state |
| **Secrets bundle** | Every platform + tenant Secret, age-encrypted |

System backups are written to the target you assigned to the **`system`** class
(see [Backup targets](backup-targets.md)).

## System snapshots

On **Backups → System** the **Snapshots** tab gives you block-level snapshots of
the platform PVCs, with per-snapshot actions: take an on-demand snapshot,
restore (in-place revert), and prune older snapshots. CNPG database clusters
collapse into a single row. Snapshots are the quickest way back from an
accidental change when the infrastructure is otherwise intact.

The **Backups** tab covers the off-cluster artefacts: Postgres WAL + base, etcd
snapshots, the secrets bundle, and other restic-backed components.

## Postgres WAL & point-in-time recovery

The platform database runs under CNPG with continuous WAL archiving. That gives
you **point-in-time recovery (PITR)**: restore the latest base backup and replay
WAL up to a chosen moment, so you can recover to just before a bad change. The
recovery-point window is bounded by how often WAL is archived (≈5 minutes in
steady state).

PITR restores run out-of-band (from a recovery host, not the panel) and create a
*new* CNPG cluster from the backup, leaving the live database intact until you
deliberately cut over. The Disaster Recovery page gives you the exact command.

## The DR bundle and your age key

The whole-cluster recovery story rests on two things: an encrypted **bundle** of
everything that matters, and the **key** to decrypt it.

- **Bundle-everything semantics** — the secrets bundle captures the full Secret
  inventory across the cluster, age-encrypted to your operator recipient. The
  daily secrets-backup CronJob refreshes it and uploads it to your `system`
  target.
- **The operator age key** — a keypair generated at first bootstrap. The public
  half lives on the cluster; the **private half is printed once, at install, and
  never stored on the cluster.** It is the only thing that can decrypt your
  backups.

!!! danger "Keep the age key safe — and off the cluster"
    If you lose your `AGE-SECRET-KEY-1…` private key, **your backups become
    permanently unrecoverable**. If it leaks, anyone with your backups can read
    them. Store it in at least two places that are not the cluster:

    - a password manager (1Password / Bitwarden / Vaultwarden), and
    - an offline paper copy in a safe (recommended for production).

    Never paste it into chat, email, or a private repo. Never back it up
    alongside the encrypted backups it unlocks. Full guidance:
    [Operator Key Setup](https://github.com/insulahq/insula/blob/main/docs/operations/OPERATOR_KEY_SETUP.md).

Check which recipient is currently active:

```bash
kubectl get configmap platform-operator-recipient -n platform \
  -o jsonpath='{.data.recipient}'
```

## The secrets lifecycle (bootstrap bundle)

Bootstrap also writes a Tier-1 secrets bundle to the first server. Pull it off,
verify it, then delete it from the host:

```bash
make secrets-fetch HOST=root@<server>     # pull *.tar.age + the age key
make secrets-restore BUNDLE=<bundle.tar.age> KEY=<age.key>   # restore later
```

Lost the admin password? Reset it on the server in under a second:

```bash
scripts/admin-password-reset.sh --email <addr> --random
```

The full three-tier model (bootstrap-time / runtime / operator-rotated secrets)
and the daily CronJob that keeps the bundle current are in
[Secrets Lifecycle](https://github.com/insulahq/insula/blob/main/docs/operations/SECRETS_LIFECYCLE.md).

## Cold restore — getting a cluster back

When a cluster is gone, you rebuild on a fresh VM and restore from backups. The
high-level sequence:

1. **Bootstrap a fresh k3s VM** with the *same* operator age recipient so the
   existing backups stay decryptable.
2. **Restore the secrets bundle**, then **Postgres** from the `system` target,
   then **mail** from the `mail` target.
3. **Verify** with the smoke test.

The **Backups → Disaster Recovery → Restore Instructions** tab renders the exact
copy-paste commands for *your* cluster, with placeholders highlighted — secrets
restore, Postgres-from-shim, mail-from-shim, and the verification step.

### `platform-ops dr verify` / `dr restore`

`platform-ops` can inspect and restore a DR bundle directly from a node — useful
when the cluster (and the panel) is down:

```bash
platform-ops dr verify     # decrypt + read the bundle manifest (read-only)
platform-ops dr restore    # restore from a DR bundle (partial rows | full)
```

`dr verify` is read-only and works even with the cluster down — it confirms the
bundle decrypts with the key you have *before* you touch anything destructive.
The full, scripted cold-restore (etcd → Postgres → secrets → Longhorn → smoke
test) is in the
[Disaster Recovery runbook](https://github.com/insulahq/insula/blob/main/docs/operations/DISASTER_RECOVERY.md).

## Drills — practise before you need it

A restore script you have never run is a script you cannot trust. The
**Disaster Recovery → DR Drill** section tracks drills; schedule them:

- **Staging: quarterly.** Provision a throwaway VM, restore from real staging
  backups, smoke-test, destroy.
- **Production: annually.** Same flow on a throwaway VM. Record date, operator,
  wall-clock recovery time, and any bugs found.

!!! tip "The decrypt smoke-test is your safety gate"
    The restore script pulls the newest secrets bundle and tries to decrypt it
    with your key **before** doing anything destructive. If the key doesn't
    match, it stops there. Always let that gate run.

??? info "Under the hood"
    Postgres backups use the CNPG barman-cloud plugin writing through the
    rclone-shim (`s3://system/postgres`), with daily base backups and continuous
    WAL archiving; the reconciler toggles `isWALArchiver` on only when the
    `system` class is bound, to avoid filling `pg_wal/` when unassigned. etcd
    snapshots upload hourly via the shim with a sha256 sidecar. The secrets
    bundle is encrypted to the `platform-operator-recipient` ConfigMap value.
    `dr restore` wraps the same restore engine the script uses, never throwing
    raw errors and scrubbing credentials from JSON output.
