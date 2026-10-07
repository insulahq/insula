# Node Health Monitoring

Operator-facing observability layer for k3s node health. Closes the
three monitoring gaps surfaced by the **2026-05-08 worker incident**:

> Calico Felix crash-looped for 10 days writing core dumps into the
> calico-node container's writable layer (28 GB → DiskPressure on
> the worker → kubelet evicted Longhorn pods → worker silently lost
> `driver.longhorn.io` registration → tenant PVCs that needed a worker
> replica failed to bind). Nothing in the platform alerted.

## What it covers

The 5-minute reconciler (`backend/src/modules/node-health/`) tracks
three signal classes per node:

| Signal | Source | Severity trigger |
|---|---|---|
| Pressure (`DiskPressure` / `MemoryPressure` / `PIDPressure`) | `kubectl get node` conditions | Any pressure → **critical** |
| CSINode drivers vs cluster baseline (mode of cluster) | `storage.k8s.io/v1/CSINode` | Missing baseline driver → **critical** |
| Pod evictions in last hour | `events.k8s.io reason=Evicted` | ≥3/hr → **warning**, ≥10/hr → **critical** |
| Disk usage % (Phase 2) | kubelet `/stats/summary` (not yet wired) | ≥75% → warning, ≥90% → critical |

Plus `not Ready` → critical.

## Detection latency — two loops, on purpose

| Loop | Interval | What it does |
|---|---|---|
| `fast-down-watch` | **30 s** | One `listNode`. Announces a node it observed transition into NotReady, and nothing else. |
| `node-health` reconciler | 5 min | Everything else: pressure, CSI drivers, evictions, kubelet disk stats, severity, `node_health_state`. |

The split exists because the reconciler's other signals are expensive (a
kubelet `/stats/summary` per node, two cluster-wide event lists), and that
cadence is right for those and wrong for "is a node dead". During the
2026-09-11 drill the platform served `ready: true` for a node that had been
offline **4 m 20 s** — and because losing that node restarted the platform-api
pods, the reconciler's timer restarted too, delaying detection of the very
event that caused it.

The fast watch shares the reconciler's dedupe key, so whichever fires first
wins and the operator never gets two notifications for one node going down.

> **A NotReady node's metrics are frozen, not live.** Its kubelet has stopped
> posting, so CPU / memory / pod counts stay at their last reported values.
> The Cluster Nodes page used to render those beside a NotReady pill labelled
> "just now"; it now says *metrics unavailable — kubelet not reporting*.

## How notifications fire

- Severity transition (any direction) → 1 notification per admin /
  super_admin user.
- Sustained warning or critical → 1 re-notification every 24 h.
- Recovery to normal → 1 notification.
- A node going NotReady is announced **once**, by the categorised
  `admin.node_down` dispatch. The raw per-severity row is suppressed in that
  case — emitting both produced two notifications for one event, one of which
  carried the wrong severity (the raw insert never set `severity`, so a
  CRITICAL transition defaulted to `info`).

Notifications carry `resourceType=node_health` and `resourceId=<node-name>`
so the admin panel's bell icon can deep-link.

## Joining nodes — the alert grace window

A server or worker that is bootstrapping is NotReady for several minutes, and
its Calico / Longhorn CSI pods arrive one at a time. Without a grace window that
read as an outage the moment the node registered. So **notifications** about a
joining node are held; its **state** is not — the Cluster Nodes page, the Node
Health tab, `node_health_state` and the memory-event list show the real state
throughout.

A node is *joining* while either holds:

| Rule | Window |
|---|---|
| Its Kubernetes Node object is young | `metadata.creationTimestamp` + grace. Stamped by the API server, so a platform-api restart or a database restore cannot reset it; a node deleted and re-registered gets a fresh window. |
| A `ClusterPendingPeer` for one of its addresses still exists | CR `creationTimestamp` + grace — capped, so a forgotten CR (TTL up to 24 h) cannot silence a node for a day. |

Grace is **30 minutes** by default: `NODE_JOIN_ALERT_GRACE_MINUTES` on the
platform-api Deployment (`0` disables it; capped at 1440). Held during the
window:

| Detector | Notifications held |
|---|---|
| `fast-down-watch` (30 s) | `admin.node_down` |
| `node-health` reconciler (5 min) | `admin.node_event` severity transitions, `admin.node_down`, `admin.node_rebooting`, `admin.node_startup_complete` |
| Memory events (same tick) | `admin.node_memory_event_*`, `admin.tenant_pod_oom`, `admin.system_pod_oom` — the events are still recorded |
| Calico / Longhorn CSI watcher (5 min) | `admin.node_event` "Calico is missing", "Longhorn CSI regressed", … |
| SLO evaluator (60 s) | `admin.slo_alert_*` for any series whose `node` label names the joining node — `node-cpu`, `node-memory`, `longhorn-headroom`, `node-kernel-oom` and `scrape-target-down` for that node's kubelet/Traefik/Longhorn targets |

**No health alert is lost.** Each detector keeps a suppressed node out of the
state it compares against next time, so a node that is *still* unhealthy when
its window closes is reported on the first tick after it (within ~30 s for
NotReady, ~5 min for the rest). A node that came up healthy inside the window
produces no alert and no "recovered" message. Suppression is logged
(`… is joining (joined recently) — NotReady alert suppressed until 14:32 UTC`),
and the *joined* notification below states the time alerts resume.

Two deliberate edges:

* **Reboot notices are events, not states, and are not sent late.** A shutdown
  that began inside the window never produces `admin.node_rebooting` ("is
  rebooting" twenty minutes after the fact would be false). If the node is
  still down when the window closes it is reported by `admin.node_down`; when
  it comes back on a new boot afterwards, `admin.node_startup_complete` fires
  and says no shutdown notice was sent.
* **The window holds back news only.** If the operator was already told a node
  is unhealthy — say an established node that a fresh `ClusterPendingPeer` now
  matches because it is being re-bootstrapped — that node keeps the normal
  rules, so its recovery is still reported.

SLO alerts follow the same rule with one visible difference: a held alert still
shows as **firing** on Monitoring → SLOs and in the dashboard's alert count —
only the notification waits. It is sent on the first evaluator tick after the
window if the alert is still firing; if it clears inside the window, neither a
"firing" nor a "resolved" notification is sent. Rules without a `node` label
(cluster-wide ones, per-pod OOM) are never held.

## Node membership notifications

| Category | When | Severity |
|---|---|---|
| `admin.node_joined` | a Node registers that the inventory has no row for — or whose row was marked removed (a re-join). Names role, every address, Kubernetes version and when health alerts resume. | info |
| `admin.node_removed` | a node is deleted from **Cluster → Nodes**, or an inventory node is missing from a **successful, non-empty** Node list (e.g. `kubectl delete node`). | warning |

Both are detected by the 60-second node-sync reconciler from the persisted
`cluster_nodes` inventory, never from memory, so a platform-api restart
re-announces nothing:

- **First sync of an empty inventory is the baseline** — a fresh install or a
  fresh database records every node and announces none.
- **A failed Node list never declares a removal**, and an empty one is treated
  as an API anomaly rather than every node leaving at once.
- **Exactly once across replicas.** Each transition is claimed in SQL
  (`INSERT … ON CONFLICT DO NOTHING RETURNING`, `UPDATE … SET removed_at …
  WHERE removed_at IS NULL RETURNING`); only the claimant notifies.
- The row of a node removed outside the panel is **kept** (shown as an orphan
  for review) with `cluster_nodes.removed_at` set; removing it from the panel
  afterwards does not announce the removal a second time.
- An orphan last seen more than 24 h before it was noticed missing is recorded
  as removed **without** a notification — that is a node that left long ago
  (typically before this feature was deployed), not news.

## Operator surfaces

- **Monitoring → Node Health tab** (`/admin/monitoring`): full per-node
  table — severity, ready, pressures, CSI driver count, evictions/h,
  disk %, observed-at. "Reconcile now" button forces a tick (skips the
  5-min wait).
- **Nodes & Storage → Cluster Nodes tab**: per-node card header now
  carries a compact severity badge when severity != normal. Hover the
  badge for the full pressure / CSI / eviction summary.

## Bootstrap-side disk caps

`scripts/bootstrap.sh:configure_node_logging_caps()` writes three
guards that prevent *future* unbounded log/dump growth:

1. `kernel.core_pattern = |/bin/false` (`/etc/sysctl.d/99-platform-no-core-dumps.conf`).
   Drops core dumps on the floor — exactly the bleed that caused the
   28 GB calico-node growth on 2026-05-08. Override per-host by
   removing the file and setting `core_pattern` manually if you need
   real cores for a debug session.
2. `* hard core 0` (`/etc/security/limits.d/99-platform-no-cores.conf`).
   Belt-and-suspenders pairing with the sysctl above.
3. `SystemMaxUse=2G` (`/etc/systemd/journald.conf.d/99-platform-cap.conf`).
   Caps systemd-journald disk use to 2 GB (default is auto-detected
   ≤ 4 GB on Debian — too much for the 38 GB Hetzner CX21).
4. `/etc/logrotate.d/calico` — daily rotate of `/var/log/calico/*.log`
   so a stuck calico-node pod can't grow its host-mounted log volume
   unbounded.

Existing nodes (bootstrapped before 2026-05-08) need a manual one-shot:

```bash
ansible -i hosts all -m shell -a "$(scripts/bootstrap.sh --emit-node-logging-caps)"
# OR (single host)
ssh root@<node> bash <(scripts/bootstrap.sh --emit-node-logging-caps)
```

(`--emit-node-logging-caps` is a follow-up CLI flag — until then,
copy the four file blocks from `configure_node_logging_caps()`.)

## Severity precedence

```
not Ready                                  → critical
disk/memory/pid pressure                   → critical
missing baseline CSI driver                → critical
evictions/h ≥ EVICTION_CRITICAL_THRESHOLD  → critical (default 10)
diskUsedPct  ≥ DISK_USED_PCT_CRITICAL      → critical (default 80)
evictions/h ≥ EVICTION_WARNING_THRESHOLD   → warning  (default 3)
diskUsedPct  ≥ DISK_USED_PCT_WARNING       → warning  (default 75)
                                            → normal
```

Constants in `backend/src/modules/node-health/service.ts`. Override
via env vars in a follow-up if cluster shapes diverge.

Critical is 80, below the kubelet's own thresholds (image GC from 70 % used,
`imagefs.available<15%` — evictions from 85 % used, since k3s keeps images on
the root filesystem — and `nodefs.available<10%`). It was 90, which is the
moment the kubelet starts evicting, so it never warned first. Tenant pods are
also bounded individually — see [TENANT_DISK_LIMITS.md](TENANT_DISK_LIMITS.md).

## API

- `GET /api/v1/admin/node-health/summary` (super_admin / admin) —
  last persisted snapshot from the reconciler, sorted critical →
  warning → normal then by name.
- `POST /api/v1/admin/node-health/reconcile` (super_admin / admin) —
  run a tick now. Useful after operator-initiated remediation; the
  Monitoring page calls this on the "Reconcile now" button.

## Smoke check

`scripts/smoke-test.sh` (admin path) hits `/admin/node-health/summary`
and asserts `overallSeverity != 'critical'`. Fails the smoke run if
the reconciler reports any node in critical state.

## Worker subsystem issues — Calico CNI / Longhorn CSI {#subsystem-troubleshooting}

**Operator-facing steps live in the published manual:**
[Troubleshooting → worker-subsystem banner](https://insulahq.github.io/operator/troubleshooting/#worker-subsystem).
That is what the Cluster Nodes page links to, and it is the copy to keep
current — this file deliberately does not repeat the ladder, so the two cannot
drift.

Engineering context that does not belong in the operator manual:

- The most common Calico cause is a **missing host `iptables` binary**. We never
  use it (k3s bundles its own; the platform firewall is nftables), but NetBird
  probes for it and falls back to writing **native nft rules** into `table ip
  filter` — the table Calico drives through `iptables-nft`. Felix then fails
  every dataplane resync (`iptables-save failed because there are incompatible
  nft rules in the table`), `calico-node` stays `0/1`, and **NetworkPolicy stops
  being programmed** — a tenant-isolation regression, not a cosmetic badge.
  Fixed at source in v2026.8.2 (base package + host-migration
  `2026.8.2/0003-install-iptables-for-netbird`).
- The fix makes the table **parseable**; it does not remove the offending rules.
  They usually remain listed while Calico is healthy, so do not use their
  presence as a regression signal — use `calico-node` readiness and the absence
  of the resync error.
- Networking faults cascade: a broken CNI dataplane times out kubelet probes to
  pod IPs and crash-loops unrelated workloads, which recover on their own once
  Calico is fixed. Check Calico before investigating probe timeouts elsewhere.

## UI-actionable recovery procedures

Every node row with severity != normal gets a **Recover…** button on
the Monitoring → Node Health tab. The modal lists action options
(suggested-first based on the detected condition) and requires:

- Operator types the node name to confirm
- Operator types a reason ≥ 3 chars (audit-logged)
- Click "Run action"

All actions are super_admin/admin only, audit-logged, and
**idempotent** (running twice on a recovered node returns
`{ recovered: 0 }` with no error).

### Action catalogue

| Action | API | When to use | Risk |
|---|---|---|---|
| **Clean stale pod records on this node** | `POST /admin/node-health/recovery/clean-stale-pods` | Pile of `Failed` / `Evicted` / `ContainerStatusUnknown` pods on the node — typically post-DiskPressure cleanup. | Zero — pods are already dead K8s records. |
| **Restart Longhorn CSI plugin on this node** | `POST /admin/node-health/recovery/restart-csi-plugin` | `csiDriversMissing` includes `driver.longhorn.io`. Deletes the longhorn-csi-plugin pod; DaemonSet replaces; re-registers driver. | Low — ~30s CSI outage on this node. |
| **Recycle a specific system pod** | `POST /admin/node-health/recovery/recycle-pod` | A single pod has runaway storage growth (the 2026-05-08 calico-node 28GB core-dump case). Operator picks namespace + pod name. | Low — controller reschedules in seconds. |

### Allow-list

Recovery actions accept these namespaces only:

```
calico-system  longhorn-system  traefik        kube-system
cnpg-system    cert-manager     flux-system    platform-system
tigera-operator  platform
```

`platform` was added 2026-08-20: it holds the platform's own Deployments and
CronJobs, whose Failed pods are the most common stale records after a node
reboot, and which previously could not be cleaned from the UI at all.

Tenant namespaces (`tenant-*`) and CNPG **instance** pods are **always**
refused regardless of any other condition. Use the per-tenant / CNPG-failover
flows for those.

!!! warning "The CNPG guard checks the labels CNPG actually sets"
    It previously tested `cnpg.io/instance` — a label **nothing sets**, verified
    against a live cluster where zero pods carried it. The guard therefore always
    returned false; it was inert only because `platform`, the namespace that
    actually hosts the CNPG cluster, was refused outright. It now refuses on any
    of `cnpg.io/podRole=instance`, `cnpg.io/instanceName`, `cnpg.io/instanceRole`
    or `cnpg.io/cluster`. If you change this, verify against
    `kubectl -n platform get pod <db>-1 -o jsonpath='{.metadata.labels}'` — not
    against the test fixture, which is what hid the bug.

### Audit log

Every action inserts an `audit_logs` row with:

- `action_type`: e.g. `node_health.recycle_pod` (or `.noop` for
  idempotent no-ops)
- `resource_type`: `node_health_recovery`
- `resource_id`: the node name
- `actor_id`: the admin's user id
- `changes` (jsonb): `{ reason, namespace?, podName?, deleted?: [...] }`

Filter the Monitoring → Audit Log tab by `resource_type=node_health_recovery`
to see every recovery run.

## Manual fix: backfill node logging caps on existing nodes

The bootstrap-side `configure_node_logging_caps()` runs on every
fresh `bootstrap.sh` install. **Existing** nodes (bootstrapped before
2026-05-08) need a one-shot SSH remediation:

```bash
# On each control-plane + worker node:
ssh -i ~/hosting-platform.key root@<node> 'bash -s' <<'EOF'
set -e
mkdir -p /etc/sysctl.d /etc/security/limits.d /etc/systemd/journald.conf.d /etc/logrotate.d
cat > /etc/sysctl.d/99-platform-no-core-dumps.conf <<'INNER'
kernel.core_pattern = |/bin/false
INNER
sysctl --system >/dev/null
cat > /etc/security/limits.d/99-platform-no-cores.conf <<'INNER'
* soft core 0
* hard core 0
root soft core 0
root hard core 0
INNER
cat > /etc/systemd/journald.conf.d/99-platform-cap.conf <<'INNER'
[Journal]
SystemMaxUse=2G
SystemKeepFree=4G
SystemMaxFileSize=128M
RuntimeMaxUse=200M
INNER
systemctl restart systemd-journald.service || true
cat > /etc/logrotate.d/calico <<'INNER'
/var/log/calico/*.log /var/log/calico/*/*.log {
  daily
  rotate 5
  size 50M
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su root root
}
INNER
echo "  caps applied; core_pattern=$(sysctl -n kernel.core_pattern); journald=$(journalctl --disk-usage 2>&1 | head -1)"
EOF
```

Run this once per node. Idempotent — safe to re-run.

The 2026-05-08 staging cluster (staging1/2/3 + worker) had this run
inline during the incident response and is already covered.

## Verification (post-deploy)

After this feature deploys to staging, validate end-to-end by:

1. Navigate to **Monitoring → Node Health**. Confirm all nodes show
   `severity=Healthy`.
2. Click **Reconcile now** to force-tick. `lastTickAt` updates.
3. (Optional drill) On a non-production worker, fill `/var/lib/`
   manually to >88% via `dd if=/dev/zero of=/tmp/big bs=1M count=...`
   and wait one tick. Confirm:
   - Worker row shows severity=critical with `disk` pressure.
   - "Recover…" button opens the modal with **Clean stale pod records**
     suggested.
   - Notification appears in the bell icon for admin role.
4. Remove the test fill (`rm /tmp/big`); next tick clears severity
   and emits a "Node X recovered to normal" notification.

---

## Node reboot lifecycle (2026-09-11)

The 5-minute reconciler tracks each node's kernel **bootID**
(`status.nodeInfo.bootID`) in `node_health_state.boot_id` and emits two admin
notifications, both naming the node.

| Category | When | Severity |
|---|---|---|
| `admin.node_rebooting` | node leaves `Ready` on the same boot | warning |
| `admin.node_startup_complete` | bootID **changed** and the node is `Ready` | info |

### Why bootID and not the Ready condition

A changed bootID is proof the machine actually rebooted. A kubelet restart, an
API blip or a `Ready` flap all leave it untouched, so keying the "startup
complete" notification on it means that alert cannot cry wolf. The reconciler
never reports a reboot for a node it is seeing for the first time, and never for
a node whose previous bootID it does not have on record — a fresh install, a
restored database or a newly joined worker adopts the current value silently.

### The single-node limitation — read this before filing a bug

`admin.node_rebooting` needs an API server that is still running to observe the
node leaving `Ready`. On a **single-node** cluster the control plane drains with
the node:

* the shutdown budget is `shutdownGracePeriodByPodPriority`, 120 s total;
* `platform-api` sits at priority 10000 and is drained in the second group,
  roughly 70 s in;
* the reconciler ticks every 5 minutes.

So there is only a ~30 s window in which the node is NotReady *and* the API
still answers — about a 1-in-10 chance per reboot. **This is expected.**
`admin.node_startup_complete` covers it: it always fires, reports the
approximate downtime, and states explicitly whether a shutdown notice was sent.
A multi-node cluster gets both notifications reliably.

Downtime is measured from the last tick that saw the node to the moment it came
back `Ready`, so it **overstates by up to one tick interval**. The notification
says "approximate" for that reason — do not treat it as an SLA measurement.

### Reboot debris is reaped automatically

A graceful shutdown leaves dead pod *objects* behind and nothing in Kubernetes
removes them (`--terminated-pod-gc-threshold` defaults to 12500):

```
status.reason = "NodeShutdown"   Pod was rejected as the node is shutting down.
status.reason = "Terminated"     Pod was terminated in response to imminent
                                 node shutdown.
```

One 2026-09-03 production reboot left **822** of these in `tigera-operator`
alone. Giving that Deployment a real `priorityClassName` (PR #363) moved it into
the last drain group and cut it to **20 per reboot**, but not to zero: a
Deployment with blanket `operator: Exists` tolerations will always get a few
replacements bound to a node that is draining but still heartbeating. Kubelet
does not cordon a node it is shutting down, so this residue is inherent.

`node-health/shutdown-debris.ts` deletes them on each tick, **30 minutes** after
creation so the immediate post-reboot picture stays intact. It only ever selects
pods that are in terminal phase `Failed`, carry one of the two kubelet
shutdown reasons, and are owned by a controller that has therefore already
replaced them. Running pods, bare (uncontrolled) pods and CNPG instance pods are
never touched. Unlike the operator-facing **Clean stale pod records** action in
`recovery.ts`, this one *does* cover `tenant-*` namespaces — those records are
what used to poison the per-tenant OOM alerts.

### Why this matters beyond tidiness

These records are pod objects carrying `exitCode: 137` container statuses. Exit
137 is `128 + SIGKILL` from **any** cause, and reading it as an out-of-memory
kill is what made the platform tell admins on 2026-09-11 that three named
tenants' `apache-php` containers had been OOM-killed by a reboot that killed
nothing of the sort. See `backend/src/lib/container-termination.ts` —
`isExpectedSigkill()` is the guard, and `scripts/ci-oom-classification-check.sh`
fails the build if a detector infers an OOM without consulting it.

### Exit 137 has three benign sources, not one

`exit 137` is `128 + SIGKILL` and the platform infers an OOM from it, because
some containerd versions report a real cgroup group-kill as
`{exitCode: 137, reason: "Error"}` rather than `OOMKilled`. Three things produce
the same exit code without any memory problem, and each is suppressed by
believing what the kubelet already said:

| Source | Kubelet's own signal | Guard |
|---|---|---|
| rollout / scale-down / drain | `metadata.deletionTimestamp` set | `isExpectedSigkill()` |
| node shutdown | `status.reason` = `Terminated` / `NodeShutdown` | `isExpectedSigkill()` |
| **failed liveness/startup probe** | `Killing` event: *"Container X failed liveness probe, will be restarted"* | `indexProbeKills()` |

The probe case is the one the shutdown guard cannot catch: the pod stays
**Running** and the container restarts, so no pod-level shutdown marker applies.
It is correlated by `<namespace>/<pod>/<container>` within 5 minutes of the
termination, so an unrelated OOM hours later is still reported.

In every case only the **inferred** arm is dropped. An explicit `OOMKilled` from
the kubelet always reports — a container can genuinely hit its limit *and* fail
a probe, or be killed mid-drain.

Found on a real DEV reboot 2026-09-11, after the node-shutdown fix: the reboot
produced zero false tenant OOM alerts but still raised a `critical` node memory
event for two CrowdSec containers that were merely slow to answer `/health` on a
cold boot. `scripts/ci-oom-classification-check.sh` now fails the build if
`memory-events.ts` stops calling `indexProbeKills()`, or if the reconciler stops
fetching `reason=Killing` events (which would make the index silently empty).

### The kernel decides: the OOM witness (2026-10-02)

The guards above only *drop* SIGKILLs the kubelet already explained. Everything
else used to be an inference from exit 137, and it was wrong in both
directions on real clusters:

- Production's vmsingle was OOM-killed by its own cgroup (`memory.events
  oom_kill 2`) and the kubelet reported `Error`/137, so the alert could only say
  *"cause unconfirmed"*.
- On DEV a container that simply ran `exit 137` was alerted as a possible OOM.
- A tenant nginx OOM-killed at its 32 MiB limit reached admins titled **"Tenant
  evictions (memory pressure)"** (container kills had been bolted onto the
  eviction category), and again 23 minutes later from a second, hourly OOM scan
  in the metrics scheduler.

**The witness.** The `security-probe` DaemonSet now mounts `/sys/fs/cgroup`
read-only and inotify-watches every pod cgroup's `memory.events`
(`images/security-probe/memcg.go`). Those counters are cumulative,
hierarchical, and outlive container restarts:

| Counter | Rises when |
|---|---|
| `oom` | the pod (or one of its containers) hit its memory limit |
| `oom_kill` | the OOM killer killed a process in it — at its limit **or** in a node-wide OOM |
| `oom_group_kill` | a whole container was killed as a group |

It publishes them at `data.memcg` of `platform-system/security-probe-<node>`,
with every rise bracketed by the reads before and after it. inotify is what
makes Jobs work: a pod that does not restart loses its whole cgroup within
seconds of dying, long before any poll.

The pod counters aggregate every container in the pod, so each rise also names
the containers whose **own** cgroup counted the kill — the
`cri-containerd-<id>.scope` id is the `lastState.terminated.containerID` the
kubelet reports. That is what stops one real kill being pinned on a sidecar, or
on the same container's next restart, that died of something else a minute
later. When a container cgroup was already gone before it could be read, a rise
explains at most as many deaths as it counted group kills, nearest first; the
rest stay `unconfirmed`, and a rise that names fewer containers than it counted
never rules anyone out.

**The verdict** (`backend/src/modules/node-health/oom-witness.ts:judgeKill`),
stored as `node_memory_events.cause`:

| `cause` | Evidence | Reported as |
|---|---|---|
| `memory-limit` | `oom_kill` and `oom` rose as the container died | OOM-killed at its memory limit (kernel-confirmed) |
| `node-oom` | `oom_kill` rose, `oom` did not | killed by the node's OOM killer — its own limit is innocent |
| `oom` | kubelet said `OOMKilled`, the witness adds nothing | OOM-killed (limit vs node not determined) |
| `unconfirmed` | exit 137, no usable evidence either way | SIGKILLed, cause unconfirmed |
| `not-oom` | the witness saw across the exit and nothing moved | **not recorded, not notified** |

A death is judged only against a witness snapshot taken **after** it
(`snapshotAtMs`). The probe republishes within ~2 s of an OOM rise and at least
every minute; until a covering snapshot is published the kill is held — not
recorded, because the first record is final — and a witness that never catches
up (probe down) gets 10 minutes before the kill is recorded on the kubelet's
word. Found on DEV: judging against the previous snapshot froze three kills as
kubelet-only verdicts, and for a pod the witness was already watching it would
have read "watched, no rise" — `not-oom` — and dropped a real OOM alert.

`not-oom` is only ever concluded when the witness could have seen a kill: the
pod's `memory.events` was watched live with no inotify overflow near the exit,
or a read landed after the exit, or the counters were still zero when the pod
was first read after it. Anything less falls back to the kubelet's word. A
kernel-confirmed OOM is reported even on a draining pod or one that also failed
a probe. An explicit `OOMKilled` is never denied. The kill-to-exit window is
120 s, because measured production storage stalls (8–48 s) can hold an OOM-killed process in
uninterruptible I/O.

**Routing — one notification per event, in the category it belongs to**
(`node-health/memory-event-notify.ts` is the only sender, enforced by
`ci-oom-classification-check.sh`):

| Event | Category |
|---|---|
| kubelet `Evicted` (true evictions only), tenant | `admin.node_memory_event_warning` "Tenant pods evicted (<resource>)" |
| kernel SystemOOM, or a SYSTEM pod evicted | `admin.node_memory_event_critical` |
| tenant container killed | `admin.tenant_pod_oom`, one per kill |
| platform container killed (system namespace, or a `platform.io/system` pod such as the file manager in a tenant namespace) | `admin.system_pod_oom`, one per kill |

Evictions name the resource the kubelet gave: node memory / disk / PID
pressure, or a pod exceeding its **own** ephemeral-storage limit (an eviction
with a perfectly healthy node).

**Checking a node's witness:**

```
kubectl -n platform-system get cm security-probe-<node> -o jsonpath='{.data.memcg}' \
  | jq '{available, inotify, overflowsMs, pods: (.pods | with_entries(select(.value.oomKill > 0)))}'
```

`available:false` with a `reason` means cgroup v1 or no kubepods cgroup — kills
on that node are judged on the kubelet's word alone.

