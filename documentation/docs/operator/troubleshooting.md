---
verified: 2026.7.2
---

# Troubleshooting

This page is the operator's first-response guide for the situations you're most
likely to hit. Each one starts with what to check in the **panel** (where a fix
usually exists), then the `kubectl` command if you need to go deeper.

!!! note "Two namespaces to know"
    Platform services live in the **`platform`** namespace; each tenant lives in
    its own **`client-*`** namespace. Most commands below target `platform`.

## A node shows NotReady

1. **Cluster → Nodes** — find the node. A red **Ready** pill or a severity badge
   tells you it's the right one. Expand the card for CPU/memory/disk and the
   worker-subsystem banner (Calico / Longhorn CSI).
2. **Monitoring → Node Health** — read the exact signal (pressure, missing CSI
   driver, evictions). Use the **recovery actions** there first — they fix the
   common cases (stale pods, missing Longhorn driver) without SSH.
3. Still NotReady? Check the host:
   ```bash
   kubectl get nodes
   kubectl describe node <node>
   ```
   On the node itself (via the [node terminal](nodes-and-cluster.md#the-node-terminal)
   or SSH): `journalctl -u k3s -n 200 --no-pager` (server) or
   `journalctl -u k3s-agent -n 200` (worker).
4. If the node is dead, **drain and remove** it (see
   [Nodes & cluster](nodes-and-cluster.md)) and replace it.

## The worker-subsystem banner says Calico or Longhorn CSI is degraded { #worker-subsystem }

**Work down this list in order.** Each step is cheaper than the next, and the
first two resolve most cases. Draining and re-bootstrapping is the last resort —
it is a multi-minute outage for every workload on the node, and on a single-node
cluster it is a full platform outage.

### 1. Calico degraded — check for the `iptables` binary first

```bash
command -v iptables || sudo apt-get install -y iptables   # or: dnf install -y iptables
sudo systemctl restart netbird     # only if this node runs NetBird
```

The platform's firewall is nftables and k3s bundles its own iptables, so nothing
of ours needs the package. Other host software does: **NetBird** probes for it
and, not finding it, writes native nftables rules into the same `filter` table
Calico drives through `iptables-nft`. Calico's Felix then can't read that table,
fails every dataplane resync, and `calico-node` stays `0/1 Ready`.

That matters beyond the badge: **while `calico-node` is not Ready, NetworkPolicy
is not being programmed**, so tenant isolation is degraded. Treat it as urgent.

Installers from **v2026.8.2** include the package, and a host-migration adds it
to existing nodes — this step is for anything installed before that.

Confirm it is this, and that the fix landed:

```bash
kubectl -n calico-system logs -l k8s-app=calico-node --tail=200 | grep 'incompatible nft rules'
kubectl -n calico-system get pod -l k8s-app=calico-node     # want 1/1
```

!!! note "Judge it by the pod, not the rules"
    The fix works by making the table *parseable*, not by deleting anything —
    the offending rules are often still listed afterwards while Calico is
    perfectly healthy. Use `calico-node` reaching `1/1` and the error leaving
    the log as your signal.

### 2. Read the actual error

```bash
kubectl -n calico-system describe pod -l k8s-app=calico-node | tail -30
kubectl -n longhorn-system logs -l app=longhorn-csi-plugin --tail=100
```

| Symptom | Usual cause | Fix |
|---|---|---|
| `felix is not ready … 503` | missing `iptables` | step 1 |
| CSI plugin `CrashLoopBackOff` | lost driver registration | **Restart Longhorn CSI plugin** recovery action |
| Pod `Pending` | no room on the node | free resources or add a node |
| `DiskPressure` | disk full, often logs or core dumps | [A node is running out of disk](#a-node-is-running-out-of-disk) |

### 3. Use the recovery actions

**Monitoring → Node Health → Recover…** rather than deleting pods by hand: the
actions are audit-logged, restricted to platform namespaces, and idempotent.

### 4. Check whether the failure is downstream

Networking faults cascade. A broken CNI dataplane makes kubelet's probes to pod
IPs time out, which crash-loops otherwise-healthy workloads elsewhere — and
those recover on their own once the CNI is fixed. **Fix Calico first, then
re-check** before investigating unrelated pods.

### 5. Last resort — drain and re-bootstrap

Only after the above, and only for a genuinely unrecoverable node:

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
insula bootstrap --remote <ip> --join-as worker --server <cp-ip> --token <token>
```

## A certificate won't issue

Symptoms: a site or panel serves a browser warning, or a self-signed cert.

1. Check the certificate resources:
   ```bash
   kubectl get certificate -A
   kubectl describe certificate <name> -n <namespace>
   ```
2. Confirm DNS for the hostname points at a node that can serve the ACME
   challenge, and that ports 80/443 are reachable.

!!! danger "Let's Encrypt rate limits — the most common cause"
    Let's Encrypt limits **5 certificates per exact hostname per week**. If you
    have been re-bootstrapping or re-issuing repeatedly (common while testing),
    you can exhaust this and issuance stalls until the window rolls. Symptoms
    cascade: panels fall back to self-signed, mail TLS fails. Stop re-issuing and
    wait out the window, or use the Let's Encrypt **staging** issuer for
    teardown/rebuild loops. Don't keep retrying — it only pushes the reset later.

## Mail isn't being received

1. **Email → Operations** — check the **Mail server** health banner. Open its
   details for the deliverability probes.
2. **Port exposure** — confirm the mode matches where DNS points. In *active node
   only*, `mail.…` must resolve to the active node's IP; in the haproxy modes it
   can round-robin nodes. See [Mail operations](mail-operations.md).
3. **Reverse DNS** — a missing PTR / failed FCrDNS is the top reason fresh nodes
   get mail *rejected by senders*. Set PTR at your VPS provider for every sending
   node IP.
4. From outside the cluster, smoke a port:
   ```bash
   swaks --to postmaster@mail.example.com --server <node-ip> --port 25 --quit-after EHLO
   ```
5. Stuck mid-flip? Recovery for each stuck port-exposure state is in the
   [Mail Port Exposure runbook](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_PORT_EXPOSURE.md).

## A backup target is failing

1. **Backups → Remote Storage Targets** — click **Test** on the target, and
   **Speedtest** to rule out throughput. Fix credentials/endpoint in the form
   and re-test.
2. Check the shim state:
   ```bash
   kubectl -n platform get cm backup-rclone-shim-status -o yaml
   ```
   `STATE_OK` is good. `STATE_NO_ASSIGNMENTS` means no class is bound (expected if
   you haven't configured that class). `STATE_MISSING_KEY` means the
   `BACKUP_TARGET_KEY` is gone — restore it from your secrets bundle.
   `STATE_ERROR` carries an `errorMessage` and self-heals on the next tick unless
   the cause is real.
3. See [Backup targets](backup-targets.md) and the
   [rclone-shim runbook](https://github.com/insulahq/insula/blob/main/docs/operations/BACKUP_RCLONE_SHIM.md).

## A tenant is stuck suspended, or a transition keeps retrying

Tenant state changes (suspend, archive, restore, delete) run through lifecycle
hooks. A failing hook can leave a tenant mid-transition.

1. **Platform Settings → Lifecycle Hooks** — the page shows per-hook success
   rate and recent transitions. Failed hook runs have a **Retry** button; a hook
   whose circuit breaker has tripped has **Reset breaker**.
2. Retry the failed run; if it keeps failing, the recent-transitions tree names
   the hook and its error.
3. For a hook blocked by an external-provider outage, an operator kill-switch
   exists (`LIFECYCLE_HOOK_<NAME>=disable`) — use it only during the outage.
   Details:
   [ADR-033](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-033-tenant-lifecycle-hook-registry.md).

## Tenant pods are being evicted / OOM-killed

Under real memory pressure this is the platform working as designed: nodes
run swap-less with reserved headroom, and tenant workloads are always
reclaimed before system components. Check **Monitoring → Node Health →
Memory events** for exactly what was hit and when (you'll also have been
notified). Chronic tenant evictions mean the node is oversubscribed — add a
node, or move/upsize the noisy tenant. A **SYSTEM** row in that card is
different: platform components should never lose the memory fight — treat it
as an incident and check node sizing immediately.

## Something fails with "Too Many Requests" (429)

The API allows **100 requests per minute per user**. That budget is shared by
everything that user's session is doing — page polling included — so it is
bulk actions that hit it first.

Symptoms and what to do:

- **Selecting many files and deleting them.** The file manager sends one
  bulk request rather than one per file, so this is no longer a problem.
  If you script against the API directly, delete in batches rather than a
  request per path.
- **Scripted or automated calls.** Space them out, or batch them. The error
  response carries a `retry_after` value in seconds — honour it and back off
  rather than retrying immediately.

!!! note "SFTP and SSH are not subject to this limit"
    File transfers do not consume the API budget: the gateway contacts the
    platform a handful of times per **login session**, not per file. Uploading
    thousands of small files over SFTP is fine.

    Older releases were different: SFTP *logins* shared a single platform-wide
    budget of roughly 25 per minute, and past it logins failed with an error the
    tenant could not see. Mail telemetry and backup/restore streaming shared
    that same budget — the latter could leave a bundle recorded as `partial`.
    If you see unexplained SFTP login failures, busy-hour gaps in mail
    statistics, or partial bundles when several tenants back up at once, check
    the changelog and upgrade.

## A node is running out of disk

1. **Monitoring → Node Health** flags DiskPressure as critical; **Cluster →
   Nodes** shows the disk dot red.
2. Use the **recovery actions** on Node Health first — **Clean stale pod
   records** and **Recycle a specific system pod** reclaim space from dead
   pods/runaway writable layers.
3. On the node, find the consumers:
   ```bash
   df -h /
   crictl rmi --prune          # clean unused container images
   ```
4. For mail specifically, see disk reclaim in
   [Mail operations](mail-operations.md). For Longhorn replicas, add a node and
   rebalance.

!!! note "Disk caps are already in place"
    Bootstrap configures journald caps, log rotation, and no-core-dumps so a
    stuck pod can't fill a node unbounded. A node still filling up usually means
    real data growth (tenant files, mail) — add capacity.

## The admin panel / API is down

1. Check the platform pods:
   ```bash
   kubectl -n platform get pods
   kubectl -n platform get rs        # look for ReplicaFailure (often a quota issue)
   ```
2. If `platform-api` is crash-looping, read its logs:
   ```bash
   kubectl -n platform logs -l app=platform-api --tail=200
   ```
   A missing env var or a database it can't reach is the usual cause.
3. Check the database is up:
   ```bash
   kubectl -n platform get cluster        # CNPG Cluster
   kubectl -n platform get pods -l cnpg.io/cluster
   ```
   A full Postgres volume will stop the API — recover Longhorn space or restore.
4. Once pods are back, confirm end-to-end with the smoke test:
   ```bash
   ./scripts/smoke-test.sh
   ```

!!! tip "Check the rollout before blaming the build"
    If a feature 'isn't working' after a deploy, look at `kubectl -n platform
    get rs` for a ReplicaFailure (commonly a resource quota) **before** assuming
    a bad image — that's almost always the real cause.

## Where logs live

| What | Where |
|---|---|
| platform-api | `kubectl -n platform logs -l app=platform-api` |
| A tenant's pod | `kubectl -n client-<id> logs <pod>` |
| Ingress (Traefik) | `kubectl -n traefik logs <traefik-pod>` |
| Mail | `kubectl -n mail logs <stalwart-pod>` |
| The k3s service on a host | `journalctl -u k3s` (server) / `journalctl -u k3s-agent` (worker) |
| Audit trail | **Monitoring → Audit Logs** in the panel |

## Going deeper

Two operator runbooks back this page (note: parts predate the current stack —
trust the panel and the commands above when they differ):
[Operational Runbooks](https://github.com/insulahq/insula/blob/main/docs/operations/OPERATIONAL_RUNBOOKS.md)
and
[Incident Response Runbook](https://github.com/insulahq/insula/blob/main/docs/operations/INCIDENT_RESPONSE_RUNBOOK.md).
For full-cluster recovery, go to [System backups & DR](system-backups-dr.md).
