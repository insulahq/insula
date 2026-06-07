---
verified: 2026.6.7
---

# Nodes & cluster

A **node** is one Linux server running k3s. A fresh Insula install is a single
node that wears every hat: it runs the control plane, the panels, the database,
mail, and your tenants' workloads. As you grow, you add more nodes and the
platform spreads the load.

Nodes come in two roles:

- **Server** — runs the control plane (etcd, the API server) plus platform
  services. By default a server does *not* host tenant workloads — it is
  production-safe.
- **Worker** — runs tenant workloads only. Workers do not join etcd.

You manage all of this from **Cluster → Nodes** in the admin panel.

## The node cards

Each node is a card. The header tells you, at a glance:

- **Role pill** — `server` or `worker`.
- **`hosts tenants`** / **`system only`** — whether tenant pods may schedule
  here (`canHostTenantWorkloads`).
- **Ready pill** — `Ready`, `NotReady`, or `Unknown` (the Kubernetes node
  condition).
- **last-seen** — colour-coded: green (< 5 min, healthy), amber (5–30 min,
  stale), red (> 30 min, likely dead).
- **CPU / Mem dots + pod count** — a quick saturation read (green < 75 %,
  amber ≥ 75 %, red ≥ 90 %).
- **Cordoned / Drained / Orphaned** tags when relevant, and a **severity
  badge** (warning / critical) when node-health detects a problem.

Expand a card for live CPU, memory, ephemeral storage, scheduled pods, taints,
operator notes, and the node's storage. A red **subsystem** banner appears if
Calico (the network plugin) or the Longhorn CSI driver is degraded on that node.

The card actions are **Edit**, **Terminal** (super_admin, Ready nodes only),
**Drain Node**, and — once drained — **Delete**.

!!! tip "The reconciler is the source of truth"
    The page is driven by a backend reconciler that re-reads the cluster every
    60 seconds. After you add, label, or remove a node, give it up to a minute
    to appear or disappear.

## Adding a node

New nodes are joined by running `bootstrap.sh` against the new host. The safe,
supported path **pre-authorises the new node first** so its k3s join handshake
gets through the host firewall.

### Pre-enrol, then bootstrap

1. Go to **Security → Network Trust → Pending Peers → Pre-Enroll Node**.
2. Paste the new node's public IP, pick its role (server/worker), and set a TTL.
   This creates a `ClusterPendingPeer` and opens the control-plane ports to
   that IP across every existing node within ~30 s.
3. Click **Get bootstrap command** and run the rendered `bootstrap.sh` on your
   workstation. You supply the join token from an existing server:
   ```bash
   cat /var/lib/rancher/k3s/server/node-token
   ```
4. Once the node registers, its IP moves into the permanent `cluster_peers`
   firewall set automatically and the pending-peer entry self-deletes after a
   short grace window.

!!! warning "Do not hand-edit the firewall to let a peer in"
    A manual `nft` rule for a new peer is reverted by the firewall reconciler
    within ~30 s. Always pre-enrol via the **Pending Peers** tab (or the
    `ClusterPendingPeer` CR). The reconciler is authoritative.

The full procedure, including growing 1 → 3 servers for real high availability,
is in the
[Multi-Node Runbook](https://github.com/insulahq/insula/blob/main/docs/operations/MULTI_NODE_RUNBOOK.md)
and
[Cluster Network](https://github.com/insulahq/insula/blob/main/docs/operations/CLUSTER_NETWORK.md).

!!! note "Servers come in odd numbers"
    etcd needs a majority to accept writes. Run **1, 3, or 5** servers — never
    an even count. Two servers are strictly a stepping-stone to three; they do
    not tolerate a failure. Three servers tolerate one loss; five tolerate two.

## Cordon, drain, and maintenance

Before you reboot, patch, or retire a node, **drain** it so its workloads move
elsewhere. From the node card click **Drain Node**. A modal computes the impact:

- **Pinned tenants** — tenants with a workload or volume on this node. Pick one
  re-pin target per tenant (or **Auto** to clear the pin). The orchestrator
  moves every Deployment, StatefulSet, and Longhorn volume in that tenant's
  namespace together. Leaving a tenant on **Stay** blocks the drain.
- **Non-system pods** — what gets evicted; controllers recreate them elsewhere.
- **Last-replica risk** — if this node holds the *only* healthy replica of a
  platform volume (Postgres, mail), the drain is **refused** unless you tick
  **"I accept data risk — force drain even with last replicas here."**

Click **Apply re-pin & drain**. When the node is fully drained — cordoned, no
tenant pods, no pinned tenants, no attached replicas — a green banner appears
and **Delete** unlocks.

!!! danger "You cannot drain your last tenant-capable node"
    If a node is the only schedulable node that can host tenant workloads,
    draining it is refused with `NODE_DRAIN_BLOCKED_LAST_NODE` (HTTP 409) —
    draining it would leave every tenant pod Pending with nowhere to go. Add
    capacity first.

To put a node back into service after maintenance, the platform un-cordons it
when appropriate; you can also `kubectl uncordon <node>` directly.

## Removing a node

1. **Drain** it (above) and wait for tenants to reschedule.
2. Click **Delete** on the card → **Confirm Delete**. This runs
   `kubectl delete node` and removes the inventory row. **The host itself keeps
   running** — Insula does not power it off.
3. On the host, uninstall k3s: `/usr/local/bin/k3s-uninstall.sh` (server) or
   `k3s-agent-uninstall.sh` (worker), then release the VPS.

### Orphaned nodes

If a node was removed from k3s out-of-band, its inventory row survives as an
**Orphaned** card with no live Kubernetes node behind it. Use **Remove orphan**
to delete just the stale row — no cluster action is taken.

## The node terminal

The **Terminal** button (red, on every Ready node card) opens a **root shell on
the host itself** — not inside a container. It is `super_admin`-only, fully
audited, and ephemeral.

How it works for you:

1. Sign in as `super_admin` and open **Cluster → Nodes**.
2. Click **Terminal** on a Ready node.
3. If your last credential check was 30 minutes ago or more, you are prompted
   to re-authenticate (password and/or passkey). This is a **step-up** gate.
4. You land as `root` in the node's host namespaces — `hostname` returns the
   node's name, and you see the node's real filesystem.
5. Close the modal (×, Escape, or close the tab) and the privileged pod is
   deleted within ~10 s.

The session also self-destructs after **15 minutes idle** or a hard **1-hour**
cap, whichever comes first.

!!! note "OIDC-only accounts cannot use the terminal"
    The step-up gate needs a password or passkey. If you sign in only through
    an external OIDC provider, you will get `STEP_UP_UNAVAILABLE` (409) — enrol
    a passkey to gain access.

The audit log records who opened a session, which node, when, for how long, and
why it closed — but **never keystrokes or output**. Full design and the
operator-disable switch are in the
[Node Terminal runbook](https://github.com/insulahq/insula/blob/main/docs/operations/NODE_TERMINAL.md).

??? info "Under the hood"
    The terminal spawns a one-shot privileged pod pinned to the target node,
    then `kubectl exec`s `nsenter -t 1 -m -u -i -n -p --` into PID 1's host
    namespaces. The WebSocket token is 256-bit, single-use, 60-second TTL, and
    redacted from logs. When platform-api runs more than one replica (HA-3), a
    Traefik sticky cookie plus `Service.sessionAffinity: ClientIP` keep the
    WebSocket on the replica that created the session; a **Reconnect** button
    recovers from a mid-session pod roll. The feature flag is
    `node-terminal-enabled` in the `platform-config` ConfigMap — default ON in
    dev/staging, OFF in production.
