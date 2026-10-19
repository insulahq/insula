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
- **Committed CPU / Mem / Disk dots + pod count** — how much of each the node
  has committed (green < 75 %, amber ≥ 75 %, red ≥ 90 %).
- **Cordoned / Tenants drained / Orphaned** tags when relevant, and a **severity
  badge** (warning / critical) when node-health detects a problem.

Expand a card for the node's CPU, memory and disk, its pods, taints, operator
notes, and its Longhorn storage. A red **subsystem** banner appears if Calico
(the network plugin) or the Longhorn CSI driver is degraded on that node.

### In use, committed, free

Every capacity figure in the panel — on this page, on the dashboard's Nodes
tile and in its capacity tiles — reads the same three ways, with a two-band bar
(in use solid, committed beyond it lighter, free as the bare track):

| Figure | CPU and memory | Disk |
|---|---|---|
| **In use** | what the node's pods use right now | everything on the disk |
| **Committed** | what the node's pods have asked Kubernetes for | the size of every Longhorn volume placed on it |
| **Free** | the total less whichever of the two is larger | the same |

A node's disk comes from Longhorn, the same source as the cluster Storage tile,
and reads in GiB, like the Longhorn disk rows under it. Those rows say **held
back** for the space Longhorn never commits to volumes (its `storageReserved`
setting); **Over-committed** means the volumes placed on a disk add up to more
than its size less what is held back.

If the live figures cannot be read, the card says so and falls back to the
node inventory: committed and total stay right, in use and disk do not.

The card actions are **Edit**, **Terminal** (super_admin, Ready nodes only),
**Drain Tenants**, and — once its tenants are drained — **Delete**.

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

## Node names

Every node's Kubernetes name is **pinned** in k3s's configuration
(`/etc/rancher/k3s/config.yaml.d/10-node-name.yaml`). Without the pin, k3s takes
the name from the machine's hostname at every start — and a hostname that
changes (a provider's cloud-init resetting it at boot, say) registers the
machine as a **new** node beside its own NotReady one. That happened on a
production server: the new node had no pod network (Calico refused its
addresses, which the old node still held), so the server served nothing until
it was recovered by hand.

With the pin, the hostname is irrelevant to the cluster. New nodes are pinned
by `insula bootstrap` (choose the name with `--node-name`, or it is the
hostname at join time); nodes installed before 2026.10.12 are pinned by that
upgrade's host change `0003-pin-k3s-node-name`, which takes the name the node
is registered as — never the hostname — and restarts nothing.

A node card shows **name not pinned** while a node is not yet protected (its
host change has not run), and **name mismatch** if k3s's configuration names a
different node than the one registered — its next k3s start would register it
under that name. The host change refuses rather than guesses in that case and
when a server has already come back under another name; the Host migrations
card says why.

### When a node comes back under another name

Symptoms: after a reboot, a node stays **NotReady** and a node you never added
appears with the server's addresses (often the provider's default hostname);
on it, Calico crash-loops with *"conflicting node detected: IPv6 address
conflict"*.

!!! danger "Do not delete either node"
    For a server, both node objects carry the same etcd member, and k3s removes
    a server's etcd member when its node object is deleted — so deleting
    **either** removes a live etcd voter. **Delete** refuses this
    (`NODE_DELETE_SHARED_ETCD_MEMBER`); so must `kubectl`.

Recovery — the old node object comes back to life, with its labels, its
storage and its data:

1. On the affected host: `systemctl stop k3s` (`k3s-agent` on a worker). On a
   server, etcd keeps its quorum on the others.
2. Pin the old name — the old object's name, as Cluster → Nodes shows it:
   ```bash
   install -d /etc/rancher/k3s/config.yaml.d
   printf 'node-name: <old-name>\n' > /etc/rancher/k3s/config.yaml.d/10-node-name.yaml
   ```
3. On another server, strip the etcd role from the **duplicate** first — then
   deleting it cannot touch etcd — and delete it:
   ```bash
   kubectl label node <duplicate> node-role.kubernetes.io/etcd-
   kubectl get node <duplicate> --show-labels | grep -c node-role.kubernetes.io/etcd   # must print 0
   kubectl delete node <duplicate>
   kubectl -n kube-system delete secret <duplicate>.node-password.k3s --ignore-not-found
   ```
4. On the affected host: `systemctl start k3s` (or `k3s-agent`). The node is
   Ready again within a minute, under its old name; Calico starts once the
   duplicate is gone.
5. In the panel, **Remove orphan** on the duplicate's card — it removes only
   the platform's row.

## Cordon, drain, and maintenance

A server does two jobs: it hosts tenants and it runs the platform (the
database, mail, the operators, Longhorn). The node actions keep them apart:

| Action | Tenants | System services |
|---|---|---|
| **Can host tenant workloads** off | No new tenant lands here | Keep running **and keep starting** here |
| **Drain Tenants** | Moved to other nodes; no new ones land here | Untouched — the platform keeps using the server |
| **Cordon** | No new pod lands here | No new pod lands here either — a database rebuild or a mail failover cannot use the node |
| **Delete** | Must already be gone | Moved off, then the node is removed |

Before you reboot, patch, or retire a node, move its tenants off. From the
node card click **Drain Tenants**. A modal computes the impact:

- **Pinned tenants** — tenants with a workload or volume on this node. Pick one
  re-pin target per tenant (or **Auto** to clear the pin). The orchestrator
  moves every Deployment, StatefulSet, and Longhorn volume in that tenant's
  namespace together. Leaving a tenant on **Stay** blocks the drain; otherwise a
  tenant's volumes never hold the drain back, because the re-pin moves them.
  A running tenant's data follows its restarted pod. A tenant marked **not
  running** (stopped or suspended) has no pod for its data to follow, so the
  drain attaches its volume on the new node and Longhorn copies the data there;
  for such a tenant **Auto** picks the tenant-capable node with the most free
  space (never the drained node, a cordoned one or one that is not Ready), and
  every target is checked for room first — the drain is refused, with nothing
  changed, when no node can take the data. A tenant already pinned to another
  node keeps that node by default. Either way **Delete** unlocks only once the
  copies have left the node.
- **Non-system pods** — what gets evicted; controllers recreate them elsewhere.
- **Keep new tenants off this node** (on by default) — on a server this turns
  **Can host tenant workloads** off: a `NoSchedule` taint that tenant pods do
  not tolerate and every system service does. The server is **not cordoned**,
  so mail can still fail over to it, a database instance can still be rebuilt
  on it, and a system replica that has to move can still land there. On a
  worker, which runs no system services, the drain cordons it. Turn the
  setting back on (node card → **Edit**) when the node may take tenants again.
- **Mail** — the drain never moves mail, and a drained server stays a mail
  failover target. If mail runs on the node, the modal says **Delete** is
  refused until mail is moved; if the node is a failover target, it says where
  mail fails over once the node is deleted — and warns, with a link to the mail
  placement, when that is nowhere. The **Cordon** switch on the node's edit
  form says what a cordon leaves mail, and which database instances keep their
  only copy on the node, when you switch it on.
- **Every other volume** — the drain asks nothing about volumes that are not a
  tenant's. Platform volumes (the monitoring store, the CrowdSec store, …) and
  leftovers nothing uses any more keep their copies where they are, on a node
  that keeps running. Whether a copy that exists only on this node may go is
  **Delete**'s question (see [Removing a node](#removing-a-node)).
- **A tenant set to Stay** — not possible: a drain moves every tenant off the
  node (`NODE_DRAIN_TENANT_STAYS`). Pick Auto or another node.
- **System pods the drain leaves running** — database instances and the other
  platform services stay where they are; **Delete** moves them. In HA mode each
  PostgreSQL instance keeps its one copy on its own node; the other instances
  hold the same data. A replica counts as covered while the primary is up on
  another server. The **primary** counts as covered while it is streaming to a
  standby on another server — if its node goes down, PostgreSQL fails over to
  that standby and writes pause briefly. A server that is itself cordoned
  never counts as cover. An instance nothing covers is marked as such; the
  drain still leaves it alone. **Delete** moves a covered instance to another
  server itself, and refuses one nothing covers (see
  [Removing a node](#removing-a-node)).

Click **Drain tenants**. When no tenant pod is left on the node it is tagged
**Tenants drained** and **Delete** unlocks.

!!! note "Longhorn has to tolerate the taint first"
    Longhorn's per-node components (CSI plugin, engine image, instance
    manager) are re-created when a server reboots. On a cluster installed
    before 2026.10.12 they did not tolerate the taint, so a tainted server
    would come back without its storage. The 2026.10.12 upgrade adds the
    toleration (host-migration `0002-system-tolerates-tenant-drain-taint`;
    Longhorn's node components restart once, volumes stay attached). Until
    then, turning **Can host tenant workloads** off on a server — directly or
    through the drain — is refused with `NODE_TENANT_TAINT_UNSAFE` and nothing
    changes.

!!! danger "You cannot drain your last tenant-capable node"
    If a node is the only schedulable node that can host tenant workloads,
    draining it is refused with `NODE_DRAIN_BLOCKED_LAST_NODE` (HTTP 409) —
    draining it would leave every tenant pod Pending with nowhere to go. Add
    capacity first.

To put a node back into service after maintenance, turn **Can host tenant
workloads** back on (or, for a worker, switch **Cordon** off) on the node's
edit form. Either clears the **Tenants drained** mark.

!!! info "Two replicas, two servers"
    In HA mode the platform's two-replica components — the WAF and the
    operators that run a leader and a standby (cert-manager, the database
    operator, sealed-secrets, the Flux controllers) — keep one replica per
    server. When a server is down or cordoned and only one other could take a
    replacement, the replacement **waits** (Pending) instead of joining its
    twin, and lands back on the server when it returns; the other replica keeps
    serving meanwhile. Database instances are the exception: one may share a
    server while another is rebuilt, because an instance must be able to leave
    a server you are removing.

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

Draining tenants is still the right move before *planned* maintenance — it
moves them off the node instead of just stopping them politely. Platform
services stay where they are, and HA keeps its size
while the node is down (see [High availability → When a server is down](high-availability.md#when-a-server-is-down)).

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

## When the platform cannot see the cluster at all

If enough control-plane servers are offline at once, Insula loses its own view
of the cluster. Every admin page then shows **Cluster health cannot be
determined** instead of a health summary.

Read that banner carefully, because it is saying something specific:

- Tenant health, node status and service availability are **unknown, not
  healthy**. Nothing on those pages should be trusted while it is showing.
- **Tenants already running keep serving.** Their sites do not need the control
  plane — this is the single most important thing the banner tells you, and it
  is why a control-plane outage is not automatically a customer-facing one.
- What stops is *change*: nothing can be started, moved, or repaired until the
  control plane is back. A site that fails during this window stays down.

Where it can, the banner also names the nodes that were offline **the last time
Insula was able to look**, with how long ago that was. That reading comes from
Insula's own records rather than from the cluster, so treat it as a strong hint
about where to look first, not as current fact — the situation may have moved on
since.

Cards that count things — failed pods, failing backups — show **—** rather than
0 while the cluster is unreadable. A zero would be indistinguishable from
"nothing wrong", and Insula does not know that.

To recover, bring back enough servers for a majority: on a three-server cluster
that means two. The control plane returns on its own within seconds of quorum
being restored.

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

1. **Drain Tenants** (above) and wait for the tenants to reschedule.
2. If **mail** runs on the node, move mail first
   (**Email → Operations → Placement**) — Delete refuses until then
   (`NODE_DELETE_RUNS_MAIL`), with nothing changed. A **database instance**
   whose only copy is on the node (HA mode) is moved by Delete itself — see
   below.
3. If volumes keep their **only copy** on the node — platform volumes, or
   leftovers nothing uses — the Delete step lists them, marked *leftover, not
   in use* or *not mounted*: deleting the node deletes them. **Delete Node**
   stays disabled until you tick **Delete them with the node**
   (`NODE_DELETE_HOLDS_LAST_COPY` through the API unless the body says
   `forceLastReplica: true`). To keep one, move it first; to be rid of a
   leftover sooner, delete it on **Cluster → Storage → Orphaned volumes**.
4. Click **Delete** on the card → **Confirm Delete**. Delete **cordons** the
   node, moves its database instances (below), then moves the system pods: it
   evicts every platform pod still on it
   (DaemonSet pods and Longhorn's instance manager excepted — they belong to
   the node and go with it), respecting disruption budgets, waits up to 90
   seconds for them to leave and for the volumes they used to detach, then
   runs `kubectl delete node` and removes the inventory row. An eviction a
   disruption budget refuses, or a pod still shutting down or a volume still
   attached when the wait runs out, stops the delete with
   `NODE_DELETE_EVICTION_BLOCKED`: the node stays
   cordoned and nothing is removed — resolve it and press **Delete** again.
   (The API replica answering the request is the one pod left in place; it
   goes with the node, and a replacement starts on another server.)
   **The host itself keeps running** — Insula does not power it off.
5. On the host, uninstall k3s: `/usr/local/bin/k3s-uninstall.sh` (server) or
   `k3s-agent-uninstall.sh` (worker), then release the VPS.

### Moving a database instance off a server

In HA mode each PostgreSQL instance keeps its only copy on its own server, so
deleting that server would take the instance with it: PostgreSQL would be left
with an instance it cannot start anywhere else. **Delete** therefore moves it
first. The Delete step says which instances it will move; after
**Confirm Delete** it:

1. cordons the node, so neither the new instance nor its volume can land on it;
2. waits until the database is **whole** — every instance ready, PostgreSQL's
   operator reporting it healthy. Re-creating an instance costs the database
   that copy until the new one is ready; with another instance already down
   that would leave the primary alone with the data, so Delete does not start;
3. if the instance is the **primary**, switches PostgreSQL over to a standby it
   is streaming to on another server (writes pause briefly — the panels may
   answer slowly for a moment);
4. once the instance is a replica and the primary holds its data on another
   server, deletes the instance's volume claims whose copy is on this node, and
   its pod — PostgreSQL's operator re-creates the instance on another server
   with a fresh copy taken from the primary;
5. waits until the database is whole again (about a minute on a small
   database) before it moves the next one, then goes on with the delete.

Delete only moves an instance that another instance holds the data of. One
nothing covers — a single-instance database, or a primary that is not
streaming to a standby right now — has nothing to be re-created from: the
Delete step says so, **Delete Node** stays disabled, and the API refuses with
`NODE_DELETE_HOLDS_DATABASE`, nothing changed. Turn on high availability first
(so another server holds a copy), or wait until the standby streams again.

If a step does not finish in time — a whole database and the switchover within
3 minutes, the re-creation within 15 — Delete stops with
`NODE_DELETE_DATABASE_MOVE_STALLED`, saying which step: the node stays cordoned
and in the cluster, nothing else is removed. Press **Delete** again to
continue: an instance already re-created elsewhere is not moved twice, and the
next one waits until a re-creation still running has finished.
`kubectl -n platform get cluster system-db` shows the progress.

The instance's old volume is kept, *Released*, because the platform's storage
classes retain released volumes. Its only copy is on the node and goes with it;
two days after its release the platform deletes the volume. If the delete
stopped before the node was removed, the Delete step lists that volume as a
*leftover, not in use* under its old claim name — it no longer belongs to the
instance: tick **Delete them with the node**, or delete it sooner on
**Cluster → Storage → Orphaned volumes**.

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
