# mail-pg PostgreSQL major-version upgrade runbook

> **Audience**: operator running a PG-major bump on the Stalwart mail database
> (e.g. PG 16.9 → 17.x as Phase 2 of the PG18 migration project, or
> PG 17.x → 18.x as Phase 4).
>
> **Current applicability**: Phase 2 — `mail-pg` PG 16.9 → mail-pg-17 PG 17.5.
>
> **Risk class**: mail data + auth credentials at stake. Stalwart 0.16
> stores everything in `mail-pg` (directory, accounts, blobs, FTS, queue).
> A botched cutover loses all mailbox plaintext (cannot be re-imported —
> see `docs/02-operations/MAIL_PG_RESTORE.md` for that pain story).

## Why this can't be an in-place imageName bump

CNPG's instance manager refuses to start a PG 17 process on a data
directory created by PG 16. The `imageName` field in a `Cluster` CR is
NOT a major-version upgrade lever. The supported paths for a major bump
are:

1. **`bootstrap.initdb.import`** — declarative pg_dump + pg_restore between
   two clusters (operator-native, used in this runbook).
2. Manual `pg_dump | pg_restore` via Job — more control, more pieces to
   coordinate by hand.
3. `pg_upgrade` via in-cluster Job — fastest for big DBs, but the
   tooling story is rougher.

For mail-pg's small size (~11 MB on staging at the time of writing), option 1
is the right balance of safety and simplicity.

## Prerequisites

- CNPG operator at v1.21.0+ (initdb.import GA). Confirm:
  `kubectl get deploy -n cnpg-system -o jsonpath='{.items[*].spec.template.spec.containers[0].image}'`
  As of 2026-05-06, staging is on **v1.29.0** (Phase 1 of this project).
- Source cluster is **healthy** (`Cluster in healthy state`) — the script
  refuses to run otherwise.
- Recent CNPG `Backup` for the source cluster as rollback insurance. The
  daily `ScheduledBackup` covers this; one within the last few hours
  is enough.
- Operator has `kubectl` access to the cluster + SSH to a server node.

## The migration shape

1. Apply a new `Cluster` CR `mail-pg-17` with `bootstrap.initdb.import`
   pointing at the live `mail-pg` via `externalClusters` — CNPG
   pg_dumps the source and pg_restores into the new cluster, all on the
   target PG version.
2. Verify row-count parity between source and new cluster.
3. Stop Stalwart writes (scale Deployment to 0).
4. Re-run the import OR accept the small drift window (mail-pg traffic
   is low; this is acceptable for staging).
5. Update the Stalwart ConfigMap to point at `mail-pg-17-rw` instead of
   `mail-pg-rw`.
6. Restart Stalwart, verify mailbox auth + IMAP/SMTP smoke.
7. Decommission the old cluster.

## Step-by-step

### Step 1 — Pre-cutover: take a fresh CNPG Backup of mail-pg

```bash
ssh root@staging1.phoenix-host.net
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Trigger an on-demand Backup CR (if your ScheduledBackup hasn't run
# in the last hour, do this; otherwise skip).
kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: mail-pg-pre-pg17-$(date +%s)
  namespace: mail
spec:
  cluster:
    name: mail-pg
EOF

# Watch it complete:
kubectl get backups.postgresql.cnpg.io -n mail -w
```

Wait for `phase: completed` before proceeding. This is your rollback
point — if anything goes wrong post-cutover, the runbook for restore
is `docs/02-operations/MAIL_PG_RESTORE.md`.

### Step 2 — Run the migration script

```bash
# From your local machine (the script SSHs to staging via --remote):
./scripts/migrate-mail-pg.sh \
  --remote root@staging1.phoenix-host.net \
  --source mail-pg \
  --target mail-pg-17 \
  --target-image ghcr.io/cloudnative-pg/postgresql:17.5 \
  --apply
```

The script:

1. Verifies source is healthy + target doesn't already exist.
2. Probes source row counts.
3. Generates the target Cluster CR YAML (printed to stdout for review).
4. With `--apply`: applies it, polls for Ready (~2 min for small DB), prints
   target row counts.
5. **Saves a snapshot of the source app-credentials Secret to
   `/tmp/<source>-app-credentials.before-<target>.yaml`** — this is the
   rollback artifact for Step 4d's in-place patch. When running via
   `--remote`, scp this file off the remote box to your workstation:

   ```bash
   scp root@staging1.phoenix-host.net:/tmp/mail-pg-app-credentials.before-mail-pg-17.yaml ./
   ```

**Stop here if the script reports errors or row-count mismatch.**

### Step 3 — Manual sanity check before cutover

```bash
# On staging1:
kubectl get cluster.postgresql.cnpg.io -n mail
# Expect:
# NAME         AGE   INSTANCES   READY   STATUS                     PRIMARY
# mail-pg      Xd    1           1       Cluster in healthy state   mail-pg-1
# mail-pg-17   Xm    1           1       Cluster in healthy state   mail-pg-17-1

# Compare schema between source and target:
kubectl exec -n mail mail-pg-1 -c postgres -- \
  psql -U postgres -d stalwart_app -c "\dt" > /tmp/src-tables.txt
kubectl exec -n mail mail-pg-17-1 -c postgres -- \
  psql -U postgres -d stalwart_app -c "\dt" > /tmp/tgt-tables.txt
diff /tmp/src-tables.txt /tmp/tgt-tables.txt   # expect identical

# Sanity-query a domain and an account row:
kubectl exec -n mail mail-pg-17-1 -c postgres -- \
  psql -U postgres -d stalwart_app -c "SELECT count(*) FROM <stalwart-domain-table>"
```

Replace `<stalwart-domain-table>` with whatever Stalwart calls its top
config table — `b` is the catch-all blob table in 0.16; the 27 tables
on staging match `\dt` listing.

### Step 4 — Cutover (irreversible without the Step 1 backup)

This is the downtime window. mail-pg is single-instance + Stalwart
caches no state, so the window is bounded by Stalwart Deployment
restart time (≤30s on staging).

```bash
# 4a. Stop Stalwart writes.
kubectl scale deploy -n mail stalwart-mail-v016 --replicas=0
kubectl wait pod -n mail -l app=stalwart-mail-v016 \
  --for=delete --timeout=60s

# 4b. Final delta-sync — re-run the import to pick up any writes that
# happened between the script's import finish and this scale-down.
# For low-traffic staging this is usually a no-op but it's cheap.
kubectl delete cluster.postgresql.cnpg.io -n mail mail-pg-17
./scripts/migrate-mail-pg.sh \
  --remote root@staging1.phoenix-host.net \
  --source mail-pg \
  --target mail-pg-17 \
  --target-image ghcr.io/cloudnative-pg/postgresql:17.5 \
  --apply
# (wait for the script to print parity)

# 4c. Repoint Stalwart to mail-pg-17.
# The configmap stalwart-config-v016 has STALWART_PG_HOST baked into
# the Deployment's env (deployment.yaml:94: value=mail-pg-rw...).
# Patch the Deployment env to point at the new -rw service:
kubectl set env -n mail deployment/stalwart-mail-v016 \
  STALWART_PG_HOST=mail-pg-17-rw.mail.svc.cluster.local

# 4d. Repoint Stalwart's app credentials.
# CNPG generates mail-pg-17-app (basic-auth secret). The Stalwart
# Deployment reads from mail-pg-app-credentials (Opaque). Two paths:
# (i) copy the new password into mail-pg-app-credentials (preserve
#     Stalwart's existing Secret reference)
# (ii) update the Deployment to read from mail-pg-17-app
# Path (i) is less invasive:
new_pw=$(kubectl get secret -n mail mail-pg-17-app -o jsonpath='{.data.password}' | base64 -d)
kubectl patch secret -n mail mail-pg-app-credentials \
  --type=json -p="[{\"op\":\"replace\",\"path\":\"/data/password\",\"value\":\"$(echo -n "$new_pw" | base64 -w0)\"}]"

# 4e. Scale Stalwart back up.
kubectl scale deploy -n mail stalwart-mail-v016 --replicas=1
kubectl rollout status -n mail deploy/stalwart-mail-v016 --timeout=120s
```

### Step 5 — Smoke-test the cutover

```bash
# 5a. Stalwart pod ready?
kubectl get pods -n mail -l app=stalwart-mail-v016
# Expect: 1/1 Running

# 5b. SMTP STARTTLS handshake responds?
echo "QUIT" | openssl s_client -connect staging1.phoenix-host.net:587 \
  -starttls smtp -quiet 2>/dev/null | head -3

# 5c. IMAPS handshake?
echo "a logout" | openssl s_client -connect staging1.phoenix-host.net:993 \
  -quiet 2>/dev/null | head -3

# 5d. JMAP /session with a known-good account credential.
# (Substitute a real test account email + password.)
curl -k --max-time 10 -u "test@<domain>:<password>" \
  https://stalwart.staging.phoenix-host.net/.well-known/jmap

# 5e. If the platform has a mailbox capture/restore E2E harness, run it:
ADMIN_PASSWORD=<...> ./scripts/integration-staging.sh mail
```

If any of these fail, **do not proceed to step 6**. Either:

- Roll back: scale Stalwart to 0, revert env + secret patches in step
  4c+4d, scale Stalwart to 1. Old `mail-pg` cluster is still running
  with its data unchanged.
- Investigate: check `kubectl logs -n mail deploy/stalwart-mail-v016`
  and the new cluster's logs before re-attempting.

### Step 6 — Decommission the old cluster (24 h+ after cutover)

**Wait at least 24 hours after Step 5 before doing this.** mail-pg's
data is irrecoverable post-deletion if the cutover turns out to have
hidden a bug.

```bash
# Final manual sanity:
kubectl get scheduledbackup.postgresql.cnpg.io -n mail
# Confirm a recent successful Backup of mail-pg-17 exists.

# Then delete the old cluster:
./scripts/reset-mail-pg.sh --really-delete-mail-pg
# (Yes, the script's name is "reset-mail-pg" not "delete" — same tool.
#  It demands typing DELETE-MAIL-PG so this is genuinely operator-
#  intentional.)
```

### Step 7 — Update k8s/base manifests (separate PR)

After staging is stable on `mail-pg-17`, send a follow-up PR that
updates the canonical manifest:

- `k8s/base/stalwart-v016/mail-pg/cluster.yaml`:
  - `metadata.name: mail-pg` → `mail-pg-17`
  - `imageName: …postgresql:16.9` → `…postgresql:17.5`
- `k8s/base/stalwart-v016/stalwart/deployment.yaml`:
  - env `STALWART_PG_HOST: mail-pg-rw…` → `mail-pg-17-rw…`
- ScheduledBackup CRs (`mail-pg/scheduled-backup.yaml`):
  - `spec.cluster.name: mail-pg` → `mail-pg-17`
- Also update `k8s/base/stalwart-v016/kustomization.yaml` if it
  references the old name in patches or namesuffixes.

Do **not** combine this with the migration PR — they need to be in
separate commits so `git revert` on the rename does not undo the
migration tooling.

## Rollback path

Any time before Step 6 (i.e. while the old `mail-pg` cluster still
exists):

1. Stalwart back to old cluster:
   ```bash
   kubectl set env -n mail deployment/stalwart-mail-v016 \
     STALWART_PG_HOST=mail-pg-rw.mail.svc.cluster.local
   # Restore the old password to mail-pg-app-credentials (you should
   # have a backup of the original Secret YAML — if not, take one BEFORE
   # Step 4d next time):
   kubectl apply -f mail-pg-app-credentials.original.yaml
   kubectl rollout restart -n mail deploy/stalwart-mail-v016
   ```
2. Delete the half-built target cluster:
   ```bash
   kubectl delete cluster.postgresql.cnpg.io -n mail mail-pg-17
   ```

After Step 6 (old cluster deleted), rollback requires the CNPG
Backup from Step 1 + the runbook in `MAIL_PG_RESTORE.md`. That's
why Step 6 has the 24-hour soak.

## Phase 4 reuse

For the Phase 4 (PG 17 → 18) repetition, this same runbook applies — just
substitute:

- `--source mail-pg-17`
- `--target mail-pg-18`
- `--target-image ghcr.io/cloudnative-pg/postgresql:18.x`

And update the names in the kubectl commands. The migration script is
parameterised for exactly this reuse.
