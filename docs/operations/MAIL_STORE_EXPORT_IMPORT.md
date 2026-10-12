# Mail store: manual export and import

The mail server can write its whole store to a set of plain files and load such a
set into an empty store:

```
stalwart --config <config.json> --export <directory>
stalwart --config <config.json> --import <directory>
```

The export holds everything the store holds — accounts and their credentials,
domains, DKIM keys, every setting, every mailbox and message — in files that do not
depend on the RocksDB on-disk format.

The platform does **not** run this for you. It used to, as the *mail archive*
feature, which is switched off (see
[`archive-dormant.ts`](../../backend/src/modules/mail-admin/archive-dormant.ts)).
The backup of the mail store is the **mail snapshot** under *Backups → Mail*, and
recovering from a lost node or volume goes through
[MAIL_HA_FAILOVER.md](MAIL_HA_FAILOVER.md). This runbook is for the cases a snapshot
cannot serve.

## When you need it

| Case | Why a snapshot is not enough |
|---|---|
| **Store migration** — moving the mail store to a different store backend, to another cluster, or to a Stalwart outside Insula | A snapshot is a copy of RocksDB files. Only RocksDB, at a compatible version, can read them. |
| **Rebuilding the store** — RocksDB reports damaged files but the server can still read the data | A snapshot copies damaged files as they are. An export reads the data out and an import writes fresh files. |
| **A portable copy of all mail** — for an auditor, or before a risky change | The export does not need RocksDB to be read back. |

It is not a per-tenant tool: one export holds every tenant's mail. Protect it like
the mail volume. A tenant's mail on its own is a tenant bundle
([TENANT_BACKUP.md](TENANT_BACKUP.md)).

## What it costs

- **Mail is down from step 1 until step 6.** Sending servers retry, so no mail is
  lost; users cannot read or send meanwhile, and the platform raises its mail
  health alerts. The export needs the store's lock, so there is no way to run it
  beside a live server.
- **Disk.** The export and the rebuilt store are both written to the mail volume,
  next to the live store. Have free space of **at least twice the size of the
  store**. Measured on a development cluster: a 517 MiB store gave a 340 MiB
  export; the rebuilt store was 663 MiB right after the import and 343 MiB once the
  server had run for a quarter of an hour.
- **Time.** On that cluster the export and the import took 2 seconds each. Both
  read or write every message once, so they grow with the size of the store; the
  platform has no measurement on a large one.
- **One full re-transfer afterwards.** Every file of a rebuilt store is new. Plan
  for the next mail snapshot to upload the whole store again and for every standby
  node to copy it again.
- **Disk on every standby node.** A standby copies the whole mail volume. Until
  you clean up in step 7 that is the rebuilt store *and* the old one kept for the
  way back, so each standby needs free space for two more copies of the store. This
  follows from how the standby copy works; it was not measured, the development
  cluster has no standby. If a standby is short of disk, see the note in step 5.

A rebuilt store leaves behind the space RocksDB already held as dead, which is why
the one above came out smaller. Deleted mail that the server has not purged yet is
a different matter: it is exported and imported like live mail. To reclaim disk,
use the server's own purge, not this procedure —
[MAIL_STORE_SPACE_RECLAIM.md](MAIL_STORE_SPACE_RECLAIM.md).

## Before you start

1. Do not start while a mail failover, failback or migration is running
   (*Email → Operations → Placement & migration*).
2. Take a mail snapshot under **Backups → Mail** and wait until it is listed. It is
   the way back if the mail volume itself is lost during the work.
3. Switch the mail snapshot schedule off for the duration (**Backups → Mail →
   Targets, Schedules & Retention**), and check that it took and that no snapshot
   is still running:

   ```bash
   kubectl -n mail get cronjob stalwart-snapshot     # SUSPEND must read True
   kubectl -n mail get pods | grep stalwart-snapshot # no pod may be Running
   ```

   A snapshot reads the whole mail volume. One that runs during the work uploads
   the export and the half-written new store with it, and one that runs across
   the swap in step 5 can record a store with files missing.
4. Check the free space on the mail node against the size of the store:

   ```bash
   kubectl -n mail exec deploy/stalwart-mail -c stalwart -- sh -c \
     'du -sh /var/lib/stalwart/data; df -h /var/lib/stalwart/data'
   ```

5. Run the commands below in **one shell**, from a machine where `kubectl` reaches
   the cluster — they set variables that later steps use. On a control-plane node
   `kubectl` is `k3s kubectl`; *Admin → Nodes → Terminal* gives you a shell there.

## Procedure

Every command below was run, in this order and from this document's text, on a
development cluster (Stalwart v0.16.26). The mailbox used for the test — some 200
messages in three folders, with flags — was byte-identical after the import and
again after the way back, and the counts of accounts, domains, DKIM keys and queue
quotas were the same. Mail sent to it afterwards was delivered.

### 1. Pause Flux and stop the mail server

Flux owns the mail server's replica count. Left running, it starts the server again
in the middle of your work: on the development cluster, with the Kustomization on
its 5-minute interval, a mail server scaled to 0 was running again 306 seconds
later. Pause it first.

Flux labels everything it applies with the Kustomization that owns it. Read the
name from the mail server instead of assuming it:

```bash
KS=$(kubectl -n mail get deploy stalwart-mail \
  -o jsonpath='{.metadata.labels.kustomize\.toolkit\.fluxcd\.io/name}')
KS_NS=$(kubectl -n mail get deploy stalwart-mail \
  -o jsonpath='{.metadata.labels.kustomize\.toolkit\.fluxcd\.io/namespace}')
echo "Kustomization: ${KS_NS}/${KS}"
```

If that prints an empty name, Flux does not manage this cluster's mail server;
leave out every `kubectl … patch kustomization` line of this runbook. Otherwise
pause it, and stop the mail server only once the pause is confirmed:

```bash
kubectl -n "$KS_NS" patch kustomization "$KS" --type merge -p '{"spec":{"suspend":true}}' &&
[ "$(kubectl -n "$KS_NS" get kustomization "$KS" -o jsonpath='{.spec.suspend}')" = true ] &&
kubectl -n mail scale deploy stalwart-mail --replicas=0
until [ -z "$(kubectl -n mail get pods -l app=stalwart-mail \
  --field-selector=status.phase=Running -o name)" ]; do sleep 2; done
kubectl -n mail get deploy stalwart-mail   # READY must read 0/0
```

While Flux is paused the cluster takes no other change from git either. Keep the
window short and do not start a platform upgrade inside it.

### 2. Start a helper pod on the mail volume

The helper runs the **same image as the server** — an export must be read and
written by the version that owns the store — and does nothing until you give it a
command.

```bash
IMAGE=$(kubectl -n mail get deploy stalwart-mail \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="stalwart")].image}')

kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: stalwart-store-tool
  namespace: mail
spec:
  restartPolicy: Never
  tolerations:
    - operator: Exists
  containers:
    - name: tool
      image: ${IMAGE}
      command: ["sleep", "infinity"]
      volumeMounts:
        - { name: store, mountPath: /pvc }
        - { name: store, mountPath: /var/lib/stalwart/data, subPath: stalwart }
        - { name: config, mountPath: /etc/stalwart }
  volumes:
    - name: store
      persistentVolumeClaim: { claimName: mail-stack-data }
    - name: config
      configMap: { name: stalwart-config }
EOF
kubectl -n mail wait --for=condition=Ready pod/stalwart-store-tool --timeout=120s
```

The volume is node-local, so the pod lands on the mail node by itself. `/pvc` is
the whole mail volume; the live store is `/pvc/stalwart`, which is also mounted
where the server expects it.

### 3. Export

```bash
kubectl -n mail exec stalwart-store-tool -- sh -c \
  'mkdir /pvc/stalwart-export &&
   stalwart --config /etc/stalwart/config.json --export /pvc/stalwart-export'
kubectl -n mail exec stalwart-store-tool -- sh -c \
  'ls -la /pvc/stalwart-export; du -sh /pvc/stalwart /pvc/stalwart-export'
```

The export is a directory of files named `subspace_a` … `subspace_x` (19 of them on
v0.16.26); `subspace_t` holds the message bodies and is by far the largest. A line
`WARN Log collector error … Failed to create log file` is expected: the helper has
no log directory.

**If a portable copy is all you want**, copy it off the cluster now, remove it
from the volume (`rm -rf /pvc/stalwart-export`, as in step 5) and go to step 6
without importing or swapping anything:

```bash
kubectl cp mail/stalwart-store-tool:/pvc/stalwart-export ./stalwart-export
```

### 4. Import into a new directory

The import goes into a new, empty directory beside the live store. The live store
is not touched, so nothing is lost if the import fails: delete
`/pvc/stalwart.new` and try again, or stop here.

```bash
kubectl -n mail exec stalwart-store-tool -- sh -c \
  'mkdir /pvc/stalwart.new && chmod --reference=/pvc/stalwart /pvc/stalwart.new &&
   printf "{\"@type\":\"RocksDb\",\"path\":\"/pvc/stalwart.new\"}\n" > /tmp/import-config.json &&
   stalwart --config /tmp/import-config.json --import /pvc/stalwart-export'
kubectl -n mail exec stalwart-store-tool -- sh -c \
  'ls -l /pvc/stalwart.new/CURRENT && du -sh /pvc/stalwart /pvc/stalwart.new'
```

The file `CURRENT` must exist. The mail pod treats a store directory without it as
a lost store and tries to restore one, or refuses to start.

**Moving to a different store backend:** `/tmp/import-config.json` is where the
target is named. Write the target store's settings there instead of the RocksDB
directory, and make the same change to the `stalwart-config` ConfigMap in your
overlay before step 6 — the server reads its store from that file. Insula ships and
tests RocksDB only
([ADR-046](../architecture/adr/ADR-046-stalwart-blob-store-stays-rocksdb.md)); the
run recorded here rebuilt a RocksDB store into a RocksDB store.

### 5. Swap the directories

Two renames inside the volume, done in an instant and without copying anything.
The export has done its work once the import succeeded; remove it now, before the
server starts and the standby nodes and the snapshot begin to copy the volume
again. (Copy it off first if you want to keep it, as in step 3.)

```bash
kubectl -n mail exec stalwart-store-tool -- sh -c \
  'mv /pvc/stalwart /pvc/stalwart.old && mv /pvc/stalwart.new /pvc/stalwart &&
   rm -rf /pvc/stalwart-export && ls -la /pvc'
```

`/pvc/stalwart.old` is the store as it was, kept for the way back in step 7. If a
standby node does not have the disk for a second copy of it, remove it here too
(`rm -rf /pvc/stalwart.old`) — the way back is then the snapshot you took before
you started.

### 6. Start the mail server and resume Flux

```bash
kubectl -n mail scale deploy stalwart-mail --replicas=1
kubectl -n mail rollout status deploy/stalwart-mail --timeout=300s
kubectl -n "$KS_NS" patch kustomization "$KS" --type merge -p '{"spec":{"suspend":false}}'
```

The pod's two start-up checks should both report that they found the store:

```bash
POD=$(kubectl -n mail get pods -l app=stalwart-mail --field-selector=status.phase=Running -o name)
kubectl -n mail logs $POD -c protect-from-silent-data-loss | tail -1
#   … RocksDB CURRENT MANIFEST present — DataStore exists, skip check
kubectl -n mail logs $POD -c restore-state | tail -1
#   restore-state: DataStore exists — skipping restore
```

### 7. Verify, then clean up

Check what your users would check: log in to webmail as a mailbox you know, find
mail that was there before, send a message to it from outside and see it arrive.
*Email → Health* should be green.

**To go back** to the store as it was before the import, swap the names back:

```bash
kubectl -n "$KS_NS" patch kustomization "$KS" --type merge -p '{"spec":{"suspend":true}}' &&
[ "$(kubectl -n "$KS_NS" get kustomization "$KS" -o jsonpath='{.spec.suspend}')" = true ] &&
kubectl -n mail scale deploy stalwart-mail --replicas=0
until [ -z "$(kubectl -n mail get pods -l app=stalwart-mail \
  --field-selector=status.phase=Running -o name)" ]; do sleep 2; done
kubectl -n mail exec stalwart-store-tool -- sh -c \
  'mv /pvc/stalwart /pvc/stalwart.failed && mv /pvc/stalwart.old /pvc/stalwart'
kubectl -n mail scale deploy stalwart-mail --replicas=1
kubectl -n mail rollout status deploy/stalwart-mail --timeout=300s
kubectl -n "$KS_NS" patch kustomization "$KS" --type merge -p '{"spec":{"suspend":false}}'
```

Mail that arrived after step 6 is in the store you are leaving
(`/pvc/stalwart.failed`), not in the one you go back to.

**Once you are satisfied**, remove what the procedure left on the volume, then the
helper:

```bash
kubectl -n mail exec stalwart-store-tool -- sh -c \
  'rm -rf /pvc/stalwart.old /pvc/stalwart.failed /pvc/stalwart-export && ls -la /pvc'
kubectl -n mail delete pod stalwart-store-tool
```

`ls` should show `stalwart` and `bulwark` and nothing else. Do not leave the other
directories: everything on the mail volume is part of every mail snapshot and is
copied to every standby node, so a forgotten `stalwart.old` doubles both.

Then switch the mail snapshot schedule back on (**Backups → Mail → Targets,
Schedules & Retention**).

## Archives made before the feature was switched off

The mail archive uploaded each export to the mail backup target as a restic
snapshot tagged `mail-archive`, from the host name `stalwart-archive`, in the same
repository as the mail snapshots. Its retention ran as part of each archive run.
With the feature off nothing removes these snapshots: they stay, and take up space,
until you remove them. The mail snapshots' own retention only looks at snapshots
tagged `stalwart-snapshot` and leaves them alone.

The commands below were run on a development cluster against two archive snapshots
made the way the feature made them; the three mail snapshots in the same repository
were untouched.

Start a pod that has restic and the repository's credentials:

```bash
TOOLS=$(kubectl -n mail get cronjob stalwart-snapshot \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].image}')

kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: mail-restic
  namespace: mail
spec:
  restartPolicy: Never
  tolerations:
    - operator: Exists
  containers:
    - name: restic
      image: ${TOOLS}
      command: ["sleep", "3600"]
      envFrom:
        - secretRef: { name: stalwart-snapshot-restic-repo }
      volumeMounts:
        - { name: store, mountPath: /pvc }
  volumes:
    - name: store
      persistentVolumeClaim: { claimName: mail-stack-data }
EOF
kubectl -n mail wait --for=condition=Ready pod/mail-restic --timeout=180s
```

**List them:**

```bash
kubectl -n mail exec mail-restic -- restic snapshots --tag mail-archive --no-lock
```

**Remove them.** Give the ids from the list; the space comes back with the
platform's next daily prune of the repository.

```bash
kubectl -n mail exec mail-restic -- restic forget <id> <id> …
```

**Restore one**, to import it with the procedure above. The export lands in
`/pvc/stalwart-export-restored/export/export.lz4/` — a directory, despite its name —
and that path is what you give `--import` in step 4 in place of
`/pvc/stalwart-export`:

```bash
kubectl -n mail exec mail-restic -- sh -c \
  'mkdir /pvc/stalwart-export-restored &&
   restic restore <id> --target /pvc/stalwart-export-restored --no-lock'
```

An archive holds the store as it was on the day it was made. Importing one puts
that day's accounts, settings and mail in place of today's; the platform's own
database is not rolled back with it. Use it to read old mail out, not to turn a
mail server back.

Remove the pod when you are done, and the restored export with it:

```bash
kubectl -n mail exec mail-restic -- rm -rf /pvc/stalwart-export-restored
kubectl -n mail delete pod mail-restic
```
