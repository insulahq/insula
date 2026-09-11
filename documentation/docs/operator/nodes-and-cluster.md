---
verified: 2026.7.2
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

New nodes are joined by running `insula bootstrap` against the new host. The safe,
supported path **pre-authorises the new node first** so its k3s join handshake
gets through the host firewall.

### Pre-enrol, then bootstrap

1. Go to **Security → Network Trust → Pending Peers → Pre-Enroll Node**.
2. Paste the new node's public IP, pick its role (server/worker), and set a TTL.
   This creates a `ClusterPendingPeer` and opens the control-plane ports to
   that IP across every existing node within ~30 s.
3. Click **Get bootstrap command** and run the rendered `insula bootstrap`
   command on your workstation. You supply the join token from an existing server:
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

### What happens when a node reboots

Insula configures **graceful node shutdown** on every node, so a plain
`reboot` is safe even when you have not drained first. On shutdown the kubelet
holds a systemd inhibitor lock and stops pods in waves — tenant workloads
first, then platform services including the database, and only then Longhorn's
storage components. That order matters: Longhorn is what unmounts everybody
else's volumes, so it has to be the last thing standing. Volumes are therefore
detached cleanly instead of being cut away mid-write.

!!! warning "Nodes bootstrapped before 2026.8.19"
    Older nodes shut down without draining: containers kept running while the
    host tore down the iSCSI transport underneath them, which could abort the
    filesystem journal on a Longhorn volume while Postgres was still writing to
    it, and added minutes of I/O-timeout stalls to every reboot. The fix is
    applied automatically by the 2026.8.19 host-migration the next time
    `platform-ops host-config` converges the node — no operator action needed.
    To confirm it is armed, run `systemd-inhibit --list` on the host and look
    for a `kubelet … Kubelet needs time to handle node shutdown … delay` entry.

Draining is still the right move before *planned* maintenance — it moves
workloads off the node instead of just stopping them politely.

## When a node goes offline

You do not have to go looking. Within about 30 seconds of a node leaving
`Ready`, a red banner appears on **every** admin page naming the node, and a
notification is sent.

The banner carries two things worth clicking:

- **`N tenants affected`** — opens a list of exactly which tenants are hurting,
  what is wrong with each, and what to do about it.
- **`Mail server affected`** — shown when the offline node was the one running
  mail. Every tenant with mailboxes loses mail at once, regardless of where
  their sites live.

### What happens to a tenant

It depends on the tenant's **storage tier**, because the tier decides whether
the tenant is tied to one node:

| Tier | What happens | What you do |
|---|---|---|
| **HA** | Its data has a copy on another node, so it reschedules. If it had been pinned to the offline node, Insula clears that pin automatically and tells you. | Usually nothing. |
| **Local** | Its single copy of the data lives on the offline node, and its workloads are pinned there. The tenant is down. | Wait for the node to come back, or restore the tenant from its latest backup. |

A tenant can be hit on both fronts at once — sites down *and* mail down — or on
only one. The affected-tenants list reports them separately, because the fix is
different for each.

### Recovering a tenant

In the affected-tenants list, each tenant has **Guide me through recovery**.
It shows what is wrong, offers the actions that actually apply, and asks you to
type the tenant's name before doing anything.

Moving a tenant to a healthy node is done for you there. Restoring data from a
backup is deliberately *not* — that is destructive, so it stays on the
[tenant backups](tenant-backups.md) page where it belongs.

Moving a tenant also removes any of its pods left behind on the offline node.
That step is not cosmetic. A tenant's workload is set to stop its old pod before
starting a new one, because its disk can only be mounted in one place at a time —
and a pod on a node whose kubelet is gone never finishes stopping, because
nothing is left to confirm it did. Without clearing those, the tenant would wait
behind them for as long as the node stayed offline. You may see the old pods
disappear abruptly rather than shutting down gracefully; on a node that is no
longer running, there is nothing to shut down gracefully.

!!! warning "Moving a local-tier tenant does not move its data"
    A local-tier tenant has a single copy of its disk, on the offline node.
    Re-pinning moves where its workload *runs*, but the data is still on the node
    that is down, so the tenant will not come back until that node returns or you
    restore it from a backup. The tenant's health panel says which of the two
    situations you are in — look for *the data is unreachable* rather than
    *Longhorn is rebuilding*.

### Traffic keeps being sent to the offline node

Insula does not manage your DNS, and it will not withdraw records for you. If
the offline node published an address for your sites or mail, that address
stays published and a share of requests keeps being sent into a hole until you
remove the record at your DNS provider.

This is on purpose. Your records usually live somewhere Insula has no access
to, TTLs outlast most outages anyway, and rewriting a zone automatically in the
middle of an incident is a good way to turn one outage into two.

So it tells you instead. The affected-tenants list opens with an orange
**Manual action: DNS still points at &lt;node&gt;** panel listing the exact
A/AAAA addresses to remove, with a copy button. Put them back when the node
returns.

Nodes set to **ingress: none** are left out of that list — they never published
an address, so there is nothing to withdraw. The node card also marks a
still-configured ingress badge struck-through as a second reminder.

## When the node comes back

Bringing the node back does **not** move tenants back. Anything that was
unpinned or re-pinned while it was down stays where it is, and that is usually
the right outcome — but it should never be a surprise.

**Cluster → Nodes** shows a **&lt;node&gt; is back online** panel listing every
tenant still placed elsewhere, how it got there (automatically, or by an
operator), and which way Insula leans:

| It says | Meaning |
|---|---|
| **Keep as is** | An HA-tier tenant that is now unpinned. This is *better* than the pin it lost — any node with a copy of its data can serve it. Re-pinning would put the single point of failure back. |
| **Consider re-pinning** | A local-tier tenant. Its placement is load-bearing, so decide deliberately rather than letting the outage choose for you. |

Two buttons per tenant:

- **Accept current placement** — records your decision, with a reason, and
  removes the tenant from the list. Moves no data.
- **Change placement…** — moves the tenant, including back to the node that
  just returned. This copies volume data, so it takes time proportional to the
  volume size and the tenant may be briefly unavailable.

The panel is absent when nothing is displaced. If it cannot read the placement
history it says so explicitly rather than showing an empty list — an empty list
would read as "nothing to do".

!!! note "Mail does not appear here"
    Mail failover is its own process with its own runbook. See
    [high availability](high-availability.md).

### A node's numbers freeze when it goes offline

An offline node stops reporting, so its CPU, memory and pod counts would
otherwise sit there looking current. The card says *metrics unavailable —
kubelet not reporting* instead.

## Removing a node

1. **Drain** it (above) and wait for tenants to reschedule.
2. Click **Delete** on the card → **Confirm Delete**. This runs
   `kubectl delete node` and removes the inventory row. **The host itself keeps
   running** — Insula does not power it off.
3. On the host, uninstall k3s: `/usr/local/bin/k3s-uninstall.sh` (server) or
   `k3s-agent-uninstall.sh` (worker), then release the VPS.

Deleting a node also tidies up after it: its storage-system record is removed,
and if it was named as a mail primary/secondary/tertiary, that reference is
cleared so the mail settings never point at a machine that no longer exists.

### Orphaned nodes

If a node was removed from k3s out-of-band, its inventory row survives as an
**Orphaned** card with no live Kubernetes node behind it. Use **Remove orphan**
to delete just the stale row — no cluster action is taken.

## How nodes behave under memory pressure

Insula nodes are deliberately configured so that running out of memory hurts
tenants before it ever hurts the platform:

- **No swap.** The installer disables swap and keeps it off (`cluster doctor`
  flags drift). On a hosting node, swap doesn't prevent memory problems — it
  converts them from a quick, visible pod restart into minutes of node-wide
  slowness that pages nobody.
- **Reserved headroom.** Each node reserves ~1.28 GB of RAM for the operating
  system and the Kubernetes machinery, so tenant workloads can never starve
  the node itself. Factor this into sizing — see
  [Requirements](../getting-started/requirements.md).
- **Tenants are evicted first.** Platform components run at a higher scheduling
  priority than tenant workloads. When a node genuinely runs short, the kubelet
  reclaims tenant pods (which restart or reschedule automatically) while the
  control plane, databases, and mail keep running.

Every memory incident — evictions, kernel OOM kills, containers hitting their
memory limits — lands in the **Memory events** card on
[Monitoring → Node Health](monitoring.md#memory-events) and notifies the
admins.

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
    `node-terminal-enabled` in the `platform-config` ConfigMap — ON by default
    in every environment, production included (it's the break-glass shell you
    want most exactly when things are broken); flip it off there if your
    compliance posture demands it.
