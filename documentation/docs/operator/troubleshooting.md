---
verified: 2026.6.7
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
