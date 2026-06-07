---
verified: 2026.6.7
---

# Grow to multiple nodes

A single node is a fine start. When you need more capacity, or you want any one
server to be able to fail without an outage, you add nodes and — once you have
three servers — flip on high availability with a single action. No migration
day, no rebuild.

## Node roles

| Role | Joins with | Runs |
|---|---|---|
| **Server** | `--join-as server` | The control plane (etcd) + platform services. Production-safe: by default a server does **not** host tenant workloads. |
| **Worker** | `--join-as worker` | Tenant websites and apps only — pure capacity. |

!!! note "Always run an odd number of servers"
    etcd (the cluster's consensus store) needs a **majority** to accept writes.
    3 servers tolerate losing 1; 5 tolerate losing 2. Two servers is **not**
    HA — it can't form a quorum if either is down. Use 1 → 3 → 5; never an even
    count.

## Pre-enrol the joining node

A joining node must reach the existing control plane's port 6443 the moment its
k3s starts. The cluster firewall scopes that port to known peers, so the new
node's IP has to be authorised first. Two ways:

- **From the admin panel** — pre-enrol the node under **Cluster → Networking**.
  This records the peer so the firewall lets it in (a `ClusterPendingPeer` is
  reconciled cluster-wide).
- **At bootstrap of the first server** — pass `--pre-enroll-peer <ip>` (one per
  expected joining node) so later joins succeed on the first try.

!!! warning "Manual firewall edits get reverted"
    The firewall reconciler converges peer rules from the cluster's own state.
    Authorise new peers through the admin UI (or `--pre-enroll-peer`), not by
    hand — a manual `nft` edit is undone within seconds.

## Add a node

On an existing **server**, grab the join token:

```bash
sudo cat /var/lib/rancher/k3s/server/node-token
# → K10abc...:server:def...
```

Then bootstrap the new host. Add a server (control plane):

```bash
sudo ./scripts/bootstrap.sh --join-as server \
  --server <existing-server-ip> \
  --token K10abc...:server:def... \
  --domain hosting.example.com \
  --acme-email ops@example.com
```

Or add a worker (tenant capacity):

```bash
sudo ./scripts/bootstrap.sh --join-as worker \
  --server <existing-server-ip> \
  --token K10abc...:server:def...
```

You can also drive this remotely with `--remote <host> --ssh-key <path>`.

After the script finishes, the node appears in the admin panel under
**Cluster → Nodes** (the node-sync reconciler picks it up within ~60 seconds),
with a last-seen badge: green (healthy), amber (stale), red (offline).

!!! tip "Private network underlay (optional)"
    If you run a mesh (NetBird, Tailscale) or a cloud VLAN, bring it up
    **before** bootstrap and pass `--cluster-network-cidr <cidr>` so k3s binds
    and joins over the private IP. The installer auto-detects a `wt0`/`tailscale0`
    interface in `100.64.0.0/10` and firewall-whitelists it; pinning node IPs to
    the private network is opt-in via that flag. Bootstrap does **not** install
    the mesh client for you.

## Turn on high availability

Once you have **≥3 ready server nodes**, the admin panel surfaces an **Apply
HA** action. It's a single, reversible button that takes the platform from
"any-node-failure causes an outage" to "any single server can fail without one".
Applying HA:

- scales the platform database (CNPG PostgreSQL) from 1 to **3 instances** with
  synchronous replication,
- scales the stateless platform Deployments (API, panels, auth) to **3 replicas**
  spread across nodes,
- raises Longhorn volume replicas from 1 to **3**, spread across nodes.

**Revert to Local** reverses all three with **no data loss**. The control plane
(etcd) is already HA once you have 3 servers; the mail server stays single-pod
and fails over via its Longhorn HA volume (~30–60s) rather than clustering.

Every Apply HA / Revert action is written to the audit log with a full
before/after snapshot.

??? info "Under the hood"
    - The Apply HA button only unlocks when the cluster reports ≥3 ready servers
      and the recommended tier is `ha`. The operation runs three independent
      patch loops; partial failures are reported per-resource, not aborted.
    - Workers don't join etcd; only servers do. To remove a node: drain it,
      `kubectl delete node`, run the k3s uninstall script, then release the VPS.
    - Authoritative sources:
      [MULTI_NODE_RUNBOOK.md](https://github.com/insulahq/insula/blob/main/docs/operations/MULTI_NODE_RUNBOOK.md),
      [HA_MODE.md](https://github.com/insulahq/insula/blob/main/docs/architecture/HA_MODE.md),
      [CLUSTER_NETWORK.md](https://github.com/insulahq/insula/blob/main/docs/operations/CLUSTER_NETWORK.md),
      the `usage()` text in
      [scripts/bootstrap.sh](https://github.com/insulahq/insula/blob/main/scripts/bootstrap.sh).
