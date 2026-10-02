---
verified: 2026.7.4
---

# Grow to multiple nodes

A single node is a fine start. When you need more capacity, or you want any one
server to be able to fail without an outage, you add nodes and — once you have
three servers — flip on high availability with a single action. No migration
day, no rebuild.

## Node roles

Your first server was installed with `insula bootstrap --domain …` — that
**created** the cluster. Every node you add **joins** it instead, with
`--join-as`:

| Role | Joins with | Runs |
|---|---|---|
| **Server** | `--join-as server` | The control plane (etcd) + platform services. Production-safe: by default a server does **not** host tenant workloads. |
| **Worker** | `--join-as worker` | Tenant websites and apps only — pure capacity. |

A join only sets up the new node (host hardening, firewall, k3s, node labels).
It never changes cluster-wide settings, so it takes **no** `--domain`, `--env`
or `--acme-*` — the installer refuses those on a join. They belong to the
first server.

**When adding servers, add at least TWO more at once (1 → 3), so the cluster
keeps quorum when any one server fails.**

!!! warning "Never stop at two servers"
    etcd (the cluster's consensus store) needs a **majority** to accept writes.
    3 servers tolerate losing 1; 5 tolerate losing 2. Two servers is **worse
    than one**:

    - if **either** server is down, there is no quorum and the control plane
      stops;
    - if one is lost for good, the survivor can't recover on its own — it
      needs `k3s server --cluster-reset` run on it;
    - every reboot or k3s upgrade of either server interrupts the control
      plane.

    So add servers to go straight from 1 to 3 (join the second and third back
    to back), or add workers instead. Use 1 → 3 → 5; never an even count.

## Pre-enrol the joining node

A joining node must reach the existing control plane's port 6443 the moment its
k3s starts. The cluster firewall scopes that port to known peers, so the new
node's IP has to be authorised first. Two ways:

- **From the admin panel** — under **Security → Network Trust → Pending
  Peers**, click **Pre-Enroll Node**. This records the peer so the firewall lets
  it in (a `ClusterPendingPeer` is reconciled cluster-wide), and its **Get
  bootstrap command** button shows the exact steps to run on that node (see
  [Add a node](#add-a-node)).
- **At bootstrap of the first server** — pass `--pre-enroll-peer <ip>` (one per
  expected joining node) so later joins succeed on the first try.

!!! warning "Manual firewall edits get reverted"
    The firewall reconciler converges peer rules from the cluster's own state.
    Authorise new peers through the admin UI (or `--pre-enroll-peer`), not by
    hand — a manual `nft` edit is undone within seconds.

## Add a node

### The easy way: Get bootstrap command

After pre-enrolling the node, click **Get bootstrap command** on its row in
**Security → Network Trust → Pending Peers**. The panel shows the steps to run
**on the new node, as root** (`sudo -i`) — one block you paste in a single go,
or each step on its own:

1. download the signed `insula` CLI of the **release the cluster runs** (never
   `latest`),
2. verify its signature against the cluster's own release key, then install it —
   the block stops right there unless `openssl` prints `Verified OK`,
3. join: `insula bootstrap --join-as <role> --server '<existing-server-ip>'
   --token … [--dual-stack]`.

The token depends on the role:

- **Worker** — the panel mints a **short-lived join token** for this node and
  puts it straight into the command. It is valid for at most 2 hours (the panel
  shows the expiry), can only join workers, and is revoked as soon as the
  pre-enrolment goes away — which happens on its own a few minutes after the
  node has joined.
- **Server** — a server needs the cluster's **server token**, the cluster's
  root credential, which the panel never displays. The first step reads it on
  an existing server; the join step then asks for it (hidden input, kept out of
  shell history).

`--dual-stack` is added for you when the cluster runs IPv4 + IPv6. If the
cluster's servers are pinned to a private network (`--cluster-network-cidr`),
the join step says so in a comment: add the same `--cluster-network-cidr
<cidr>` to the join line yourself — the cluster does not record that range.

### By hand

Run everything as root (`sudo -i`).

1. **Find the cluster's release.** On an existing server:

    ```bash
    insula version
    # → insula 2026.10.2
    ```

    The new node must install **that** release, never `latest`: the installer
    pins k3s per release, so a newer CLI would install a different k3s than the
    cluster runs.

2. **Read the join token.** On an existing **server**:

    ```bash
    cat /var/lib/rancher/k3s/server/node-token
    # → K10<ca-hash>::server:<password>
    ```

    Treat it like a root password: it can join servers and controls the whole
    cluster.

3. **Download, verify and install** that release on the **new host** — the
    same check you ran on the first node (see
    [verify the download](install.md#verify-the-download)). It needs `curl` and
    `openssl`:

    ```bash
    VERSION=2026.10.2   # from step 1
    ARCH=amd64          # arm64 on ARM hosts
    BASE="https://github.com/insulahq/insula/releases/download/v${VERSION}"
    curl -fsSLO "${BASE}/insula-linux-${ARCH}"
    curl -fsSLO "${BASE}/insula-linux-${ARCH}.sig"
    curl -fsSLO "https://raw.githubusercontent.com/insulahq/insula/v${VERSION}/platform/cosign.pub"
    openssl dgst -sha256 -verify cosign.pub \
      -signature <(base64 -d "insula-linux-${ARCH}.sig") "insula-linux-${ARCH}"
    # Must print "Verified OK". Anything else: delete the download and stop.
    install -m 0755 "insula-linux-${ARCH}" /usr/local/bin/insula
    ```

    Stronger: instead of downloading `cosign.pub`, copy
    `/etc/platform/cosign.pub` from an existing server — the key the cluster
    already trusts (the admin panel's command embeds exactly that key).

4. **Join.** Add a server (control plane) — and then a third right after it
    (see *Never stop at two servers* above):

    ```bash
    insula bootstrap --join-as server \
      --server <existing-server-ip> \
      --token '<node-token>' \
      --dual-stack   # ONLY if the cluster was created with --dual-stack — otherwise drop this line
    ```

    Or add a worker (tenant capacity):

    ```bash
    insula bootstrap --join-as worker \
      --server <existing-server-ip> \
      --token '<node-token>' \
      --dual-stack   # ONLY if the cluster was created with --dual-stack — otherwise drop this line
    ```

    `<node-token>` is the `K10<ca-hash>::server:<password>` line from step 2.
    `--server` takes the existing server's **IPv4** address.

You can also drive the join from your workstation with `--remote <host>
--ssh-key <path>` (the binary copies itself to the target) — run the binary of
the cluster's release there too.

`--dual-stack` must match how the cluster was created: a node that registers
only IPv4 cannot join a dual-stack cluster, and a single-stack cluster cannot
gain IPv6 by adding a dual-stack node.

A join checks the cluster **before** it changes anything on the new host: it
stops with an error if `https://<existing-server-ip>:6443/cacerts` can't be
reached (almost always because the node wasn't pre-enrolled first) or if the
token belongs to a different cluster (its `K10…` prefix doesn't match that
cluster's CA).

!!! tip "Developing from a checkout?"
    `./scripts/bootstrap.sh --join-as …` takes the same flags — see the
    [single-node install](install.md#run-it).

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
    - Changing a node's **role** in the admin panel only changes its platform
      label and taints (where pods get scheduled). It does not turn a k3s
      server into an agent or remove it from etcd — a real server → worker
      demotion means removing the node and re-joining it with
      `--join-as worker` (see the multi-node runbook).
    - Authoritative sources:
      [MULTI_NODE_RUNBOOK.md](https://github.com/insulahq/insula/blob/main/docs/operations/MULTI_NODE_RUNBOOK.md),
      [HA_MODE.md](https://github.com/insulahq/insula/blob/main/docs/architecture/HA_MODE.md),
      [CLUSTER_NETWORK.md](https://github.com/insulahq/insula/blob/main/docs/operations/CLUSTER_NETWORK.md),
      the `usage()` text in
      [scripts/bootstrap.sh](https://github.com/insulahq/insula/blob/main/scripts/bootstrap.sh).
