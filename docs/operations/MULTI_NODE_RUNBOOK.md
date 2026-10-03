# Multi-Node Runbook (M8 + M9)

Field manual for growing a running cluster from 1 → 3 → 5 servers and
adding worker nodes. Pairs with ADR-031 (architecture) and
`NODE_ROLE_TAXONOMY.md` (label/taint schema).

## Glossary

- **Server**: k3s control plane node. Runs etcd, platform-api,
  admin/tenant-panel, Postgres, Stalwart. Carries the
  `insula.host/node-role=server` label.
- **Worker**: tenant workload node. Runs the per-tenant pods,
  ingress-nginx DaemonSet, Longhorn replica.
- **Quorum**: etcd requires a majority of servers to accept writes.
  3 servers tolerate 1 failure; 5 servers tolerate 2. Never run an
  even count — it can't form a quorum on partition, and 2 servers are
  strictly *less* available than 1 (see below).

## Growing the cluster

> Node-join commands below run through the signed `insula` binary
> (`insula bootstrap …`, ADR-055) — either on the new node itself (what the
> admin panel's *Get bootstrap command* renders), or from your workstation,
> where `--remote` copies the binary to the target over SSH; no repo clone.
> Either way, use the binary of **the release the cluster runs** (`insula
> version` on an existing server), never `latest`: the installer pins k3s per
> release, so a newer binary installs a different k3s than the cluster runs.
> A checkout's `./scripts/bootstrap.sh` is the dev-path equivalent with
> identical flags.

### Create vs join — two different commands

`insula bootstrap` has exactly two modes, and they never mix:

| Mode | Command | What it touches |
|------|---------|-----------------|
| **Create** (first server only) | `insula bootstrap --domain <apex> [cluster flags…]` — **no** `--join-as`, `--server` or `--token` | Everything: k3s `--cluster-init`, cluster config, Flux, manifests, cert issuers, the admin seed, databases |
| **Join** (every other node) | `insula bootstrap --join-as server\|worker --server <existing-node-ip> --token <node-token> [node flags…]` | **Node-local only**: host hardening, firewall, k3s join, node labels/taints, Longhorn node tag (servers), the operator CLI. Never cluster-wide state |

- `--join-as` **requires** both `--server` and `--token`; `--server`/`--token`
  without `--join-as` is an error.
- A join accepts only node-scoped flags: `--host-tenant-workloads`,
  `--k3s-version`, `--k3s-installer-sha256`, `--cluster-network-cidr[-v6]`,
  `--dual-stack`/`--no-dual-stack`, `--pod-cidr-v6`, `--service-cidr-v6`,
  `--allow-source`, `--ssh-via-mesh`, `--skip-hardening`, `--skip-vpn`,
  `--dry-run`, `--plain`, `--platform-ops-release-base`, plus
  `--remote`/`--ssh-key`/`--ssh-user`. `--dual-stack` must match how the
  cluster was created.
- A join **refuses, loudly**, every cluster-scoped flag — `--domain`, `--env`,
  `--release-tag` (it sets the cluster's Flux source), `--acme-*`,
  `--trust-ca`, `--stalwart-*`, `--calico-*`, `--with-monitoring`,
  `--skip-monitoring`/`--skip-flux`/`--skip-longhorn`/`--skip-cnpg`, the smoke
  flags, the operator-key / secrets-bundle / restore flags,
  `--backup-target-*`, `--pre-enroll-peer`. Those belong to the first server;
  `insula bootstrap --help-full` is the authoritative list. (Before this split
  a server join re-ran the full cluster install against the live cluster —
  rewriting cluster config, re-applying manifests, seeding a second
  super_admin and resetting operator settings.)
- **Pre-enroll first.** Create a `ClusterPendingPeer` for the new node's IP
  (admin UI → Security → Network Trust → Pending Peers → *Pre-Enroll Node*, or
  the CR) **before** running the join. Do not `peer-firewall-add` by hand: the
  firewall reconciler reverts it within seconds, and the pending peer already
  opens the firewall.
- **Admin panel → *Get bootstrap command*** (`POST
  /api/v1/admin/cluster/bootstrap-command/<peer>`, super_admin, audited as
  `cluster.bootstrap_command.generate`) renders the steps to run **on the new
  node as root**, as one fail-closed paste block plus per-step copies:
  download the cluster's own release of `insula`, verify it with `openssl`
  against the cluster's pinned release key (embedded inline — not fetched from
  GitHub), install it, then `insula bootstrap --join-as <role> --server
  '<server-ipv4>' --token … [--dual-stack]`. `--dual-stack` (and any non-default
  `--pod-cidr-v6`/`--service-cidr-v6`) comes from the `platform-cluster-cidrs`
  ConfigMap, falling back to the Nodes' `podCIDRs`. A private-underlay cluster
  (server ExternalIP ≠ InternalIP) gets a marked comment instead of a guessed
  `--cluster-network-cidr` — the cluster does not record that CIDR.
  - **Worker:** the platform mints a k3s **agent bootstrap token**
    (`kube-system/bootstrap-token-<id>`, exactly what `k3s token create`
    writes, TTL 2 h, owned by the `ClusterPendingPeer` so it dies with the
    pre-enrolment — at the latest 5 min after the node is claimed). `k3s token
    list` on a server shows it. A joined worker keeps working after expiry: it
    authenticates with its node certificate from then on.
  - **Server:** k3s bootstrap tokens join agents only (the supervisor serves
    `/v1-k3s/server-bootstrap` to the server token alone, and the server token
    also decrypts the bootstrap data). The root server token is not readable
    through the kube API and the platform never serves it, so the first step
    reads it on an existing server and the join step prompts for it (hidden
    input, out of shell history).
- **A join checks the cluster before touching the host.** It fails up front —
  with nothing on the new node changed — when `https://<server>:6443/cacerts`
  is unreachable (usually: the node was not pre-enrolled, so the firewall drops
  it) or when the token's `K10<hash>` prefix does not match that cluster's CA
  (a token from a different cluster).

> **Dual-stack clusters: `--dual-stack` goes on EVERY node, not just the first.**
> A node that registers only IPv4 cannot join a cluster whose `--cluster-cidr`
> carries both families — kubelet is rejected outright. So if the first server
> was installed with `--dual-stack`, every `insula bootstrap` below needs it
> too, and each node needs its own usable IPv6 address (bootstrap refuses the
> flag without one). On a pinned/mesh underlay also pass
> `--cluster-network-cidr-v6` so the v6 node address comes from the mesh rather
> than the public interface — bootstrap refuses rather than splitting pod
> traffic across two underlays. Cluster CIDRs cannot be changed after install,
> so a single-stack cluster cannot gain IPv6 by adding a dual-stack node; that
> needs a rebuild (see [R13](../roadmap/ROADMAP.md#r13--ipv6-completion)).

### Add servers (1 → 3; never stop at 2)

> **⚠ A 2-member etcd is LESS available than one server.** Every k3s server
> is an etcd member and etcd needs a majority, so with 2 members:
>
> - **either** node down = no quorum — the control plane stops (twice the
>   failure surface of a single server, with no tolerance gained);
> - a node lost **permanently** leaves the survivor unable to recover on its
>   own — it needs `k3s server --cluster-reset` on the survivor to become a
>   1-member cluster again;
> - **every** reboot or k3s upgrade of either node blips the control plane.
>
> So add servers to reach **3** (1 → 3, joining the second and third back to
> back, typically the same provisioning day), or add **workers** instead —
> workers add capacity without touching etcd.

**When adding servers, add at least TWO more at once (1 → 3), so the cluster
keeps quorum when any one server fails.**

```bash
# 0. Pre-enroll each new node's IP (admin UI → Security → Network Trust → Pre-Enroll Node).
#    Its "Get bootstrap command" renders steps 1–2 to run on the node itself.

# 1. On the existing 1st server — the cluster's release and the join token:
ssh root@<server-1> insula version
# → insula <version>   (use exactly this release's binary below)
ssh root@<server-1> cat /var/lib/rancher/k3s/server/node-token
# → K10<ca-hash>::server:<password>

# 2. Provision the new VPSes, then JOIN them (node-scoped flags only —
#    no --domain / --env / --acme-*; the cluster already has those):
insula bootstrap \
  --remote <server-2-ip> --ssh-key ~/hosting-platform.key \
  --join-as server \
  --server <server-1-ipv4> \
  --token '<node-token>' \
  --dual-stack   # ONLY if the cluster was created with --dual-stack — otherwise drop this line

# 3. Immediately join the third — 2 servers is a transitional state only:
insula bootstrap \
  --remote <server-3-ip> --ssh-key ~/hosting-platform.key \
  --join-as server \
  --server <server-1-ipv4> \
  --token '<node-token>' \
  --dual-stack   # ONLY if the cluster was created with --dual-stack — otherwise drop this line
```

Each new server joins the etcd cluster. You can verify with:

```bash
ssh root@<server-1> kubectl get nodes -L insula.host/node-role
```

New server appears with the `server` label applied automatically by
`apply_node_labels_and_taints`. `canHostClientWorkloads` defaults to
`false` — the server is production-safe by default.

### At 3 servers: full HA

Once the third server has joined, the cluster has real HA:

- etcd tolerates the loss of any 1 server.
- The admin panel's "Cluster Nodes" page shows 3 servers with the
  last-seen badge.
- The M11 Load Balancer HA gate (`enforceHaGate`) now unlocks —
  operators can enable an LB if desired.
- The M10 CNPG activation runbook becomes applicable.

### Add a worker

Workers don't join etcd; they just take tenant workloads. Pre-enroll the
worker's IP first. The admin panel's *Get bootstrap command* then hands you a
complete, run-on-the-node command with a freshly minted 2-hour worker token —
no need to touch the server token at all. By hand:

```bash
insula bootstrap \
  --remote <worker-ip> --ssh-key ~/hosting-platform.key \
  --join-as worker \
  --server <any-server-ipv4> \
  --token '<node-token>' \
  --dual-stack   # ONLY if the cluster was created with --dual-stack — otherwise drop this line
```

After the script completes, from the control plane:

```bash
ssh root@<server-1> kubectl label node <worker-hostname> \
  insula.host/node-role=worker --overwrite
ssh root@<server-1> kubectl label node <worker-hostname> \
  insula.host/host-client-workloads=true --overwrite
```

Workers default to `host-client-workloads=true` via the bootstrap
message; this explicit label is only needed if you want a specific
value. The node-sync reconciler (M1) picks up the labels within 60s
and the node appears in the admin UI.

#### Workers get the operator CLI too

Bootstrap installs the cosign-verified `insula` binary and both of its
timers on **workers as well as servers**. This is not cosmetic: a worker
is a host like any other — same kernel knobs, same firewall shape, same
packages — and `platform-ops-host-config.timer` is what applies
**host-migrations**. A worker without it keeps whatever host state it was
bootstrapped with while the control plane moves on, silently (a timer that
was never installed reports no failures).

Confirm after a join:

```bash
ssh root@<worker-ip> insula version
ssh root@<worker-ip> systemctl is-active platform-ops-host-config.timer
ssh root@<worker-ip> insula host-config status   # read-only converge report
```

> **Workers bootstrapped before this landed have no CLI**, and no
> host-migration can install one — the migration runner *is* the binary.
> Re-run the same `insula bootstrap … --join-as worker` command against the
> node; it is idempotent, keeps the node joined, and installs the CLI plus
> both timers. (A worker joined with a panel-minted token: that token has
> expired — re-run with the server's node-token instead.) Verify with the three commands above. A node that reports
> `insula: command not found` has never applied a host-migration.

## Common tasks

### Give a node a display name

A node's Kubernetes name is whatever the host was called when it was installed
(`sv2.cluster.example.test`). Give it a display name under **Cluster → Nodes → Edit →
Display name** and the admin panel uses that name everywhere it shows the node: Monitoring,
the dashboard, tenant placement, mail placement, node pickers, the outage banner, terminals,
and the text of notifications, dashboard alerts and task progress. Clear the field to go
back to the Kubernetes name.

The Kubernetes name is still one hover away on every display name, and it stays wherever
you have to type or paste it: typed confirmations, `kubectl` commands shown in the panel,
and links. All staff roles can read display names (`GET /api/v1/admin/node-labels`);
only admins can change them.

### Drain a node for maintenance

```bash
kubectl drain <nodename> --ignore-daemonsets --delete-emptydir-data
```

The drain:
- Evicts tenant pods; the scheduler rebinds them on other eligible
  nodes (workers with spare capacity, or a server if
  `host-client-workloads=true`).
- Ignores DaemonSets (ingress-nginx, longhorn-manager).
- Waits for graceful shutdown.

Once maintenance is done:

```bash
kubectl uncordon <nodename>
```

### Remove a node permanently

1. `kubectl drain` as above (wait for tenants to reschedule).
2. `kubectl delete node <nodename>` — removes from the cluster.
3. `ssh root@<node> /usr/local/bin/k3s-uninstall.sh` — if it was a
   server — or `k3s-agent-uninstall.sh` for workers.
4. Release the VPS.

The node-sync reconciler drops the stale `cluster_nodes` row on the
next tick (it upserts from `kubectl get nodes`; anything missing
there is eventually cleaned up).

### Handle an unhealthy server

If etcd on a server misbehaves:

```bash
kubectl logs -n kube-system -l app=k3s --tail=200
journalctl -u k3s -n 200 --no-pager   # on the affected host
```

When an etcd quorum is at risk (2 of 3 servers healthy):
1. Don't drain the healthy one.
2. Investigate logs on the unhealthy host.
3. If unrecoverable: remove the unhealthy member from etcd first:

```bash
# On a healthy server:
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cert=/var/lib/rancher/k3s/server/tls/etcd/server-client.crt \
  --key=/var/lib/rancher/k3s/server/tls/etcd/server-client.key \
  --cacert=/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
  member list

ETCDCTL_API=3 etcdctl member remove <unhealthy-member-id>
```

Then `kubectl delete node <unhealthy-nodename>` from the k8s side,
replace the VPS, pre-enroll its IP, and run `insula bootstrap --join-as
server --server <healthy-server-ip> --token …` to join a fresh etcd member.

### A 2-server cluster lost one server for good

With only 2 etcd members the survivor has no quorum and cannot recover on
its own. On the **surviving** server:

```bash
systemctl stop k3s
k3s server --cluster-reset        # shrinks etcd to this single member
systemctl start k3s
```

Then delete the dead Node object (`kubectl delete node <dead-nodename>`)
and grow straight to 3 servers as above. This is the scenario the "never
stop at 2" rule exists to avoid.

### Changing a node's role (server ↔ worker)

The admin UI's node **role** edit (Cluster Nodes) changes only the platform
label `insula.host/node-role` and the matching taints — i.e. *scheduling*.
It does **not** change what k3s runs on the host: a node bootstrapped as a
server stays a k3s server and an etcd member whatever its label says, and a
worker never gains a control plane.

A real **server → worker demotion** is a remove-and-rejoin:

1. Make sure the remaining servers keep an odd count ≥ 3 (or exactly 1) —
   demoting one of 3 servers leaves a 2-member etcd (see the warning above).
2. `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`.
3. `kubectl delete node <node>` — k3s removes the node's etcd member on
   delete; confirm with `etcdctl member list` on a remaining server (and
   `etcdctl member remove <id>` if it is still listed).
4. `ssh root@<node> /usr/local/bin/k3s-uninstall.sh`.
5. Pre-enroll the node's IP again and re-join it with
   `insula bootstrap --join-as worker --server <server-ip> --token …`.

Worker → server is the same in reverse (`k3s-agent-uninstall.sh`, then
`--join-as server`), with the same odd-count rule.

## Monitoring

### Essential dashboards

Enable at bootstrap (`--with-monitoring`) or via Flux:

- **Node health**: `kubectl get nodes -o wide` + Prometheus
  `kube_node_status_condition`. Alert when Ready=False for >5 min.
- **etcd health**: `etcd_server_has_leader` per endpoint. Alert when
  any server reports 0 for >1 min (leader lost).
- **Server count**: `cluster_nodes` table `COUNT(*) WHERE role='server'
  AND last_seen_at > NOW() - INTERVAL '5 min'`. Should be 1, 3, or 5.
  Alert on even numbers (operator error — odd quorum required).
- **Tenant pod placement**: `count by (node) (kube_pod_info{namespace=~"client-.*"})`.
  Alert when a single node hosts >70% of tenants (bad distribution).

### Log aggregation

- platform-api: `kubectl logs -n platform deploy/platform-api`
  (or via Loki if `--with-monitoring` was set).
- Node-sync reconciler: grep `[node-sync]` in the platform-api logs —
  60s cadence, last_seen lag.
- Ingress-nginx: per-node access logs (each DaemonSet pod has its
  own).

### Node sync staleness

The admin-panel Cluster Nodes page surfaces `last_seen_at` as a
coloured badge:

- **green** < 5 min (healthy)
- **amber** 5–30 min (stale — investigate but not urgent)
- **red**   > 30 min (dead — likely removed or offline)

## Known gotchas

- **Longhorn replica rebalance on new worker**: replicas don't
  migrate automatically. On adding a worker, run
  `kubectl patch settings replica-auto-balance -n longhorn-system
  --type=json -p='[{"op":"replace","path":"/value","value":"best-effort"}]'`
  or use the Longhorn UI to rebalance manually. Watch disk I/O — the
  replica copy saturates network for the duration.
- **cert-manager + ACME challenges**: when ingress-nginx runs on
  every node (DaemonSet) and DNS points at worker-N, ACME's
  http-01 challenge must hit THAT worker. The `externalTrafficPolicy:
  Local` on the ingress-nginx Service preserves the client IP
  (needed for rate limits) AND means each worker serves only the
  hosts for which its node has a backend pod. Don't switch to
  `Cluster` without re-checking the ACME flow.
- **Flux reconciles on every server**: since Flux runs on the
  control plane, each server tries to reconcile. With 3 servers
  there can be 3 simultaneous applies on the same cluster.
  Kustomize-server-side-apply makes this idempotent, but Flux events
  get spammy. Acceptable.
- **Joining a server without `--cluster-init` fails with "etcd not
  available"**: the first server bootstrapped with sqlite can't
  upgrade to etcd without a full rebuild. Check
  `/var/lib/rancher/k3s/server/db/state.db` — if that file exists
  and `/var/lib/rancher/k3s/server/db/etcd/` does NOT, you're on
  sqlite. Rebootstrap per DISASTER_RECOVERY.md before growing.
