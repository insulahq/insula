# Local VM Lab — retained DEV and staging clusters on one host

> **Status:** built — services VM, local DEV and local staging (with its worker) run, reachable from
> the LAN by name; release candidates are tested on staging as in-place upgrades (see *Phases*).
> **Supersedes:** [`LOCAL_MULTINODE_VM_SETUP.md`](./LOCAL_MULTINODE_VM_SETUP.md) (never built).
> **Related:** [`EPHEMERAL_VM_INTEGRATION_TESTING.md`](./EPHEMERAL_VM_INTEGRATION_TESTING.md) — the
> throw-away per-run tier (`scripts/vm-integration-tests/run.sh`). The lab reuses its machinery
> (libvirt over `qemu+ssh`, cloud-init seeds, `bootstrap.sh` run verbatim) with a different lifecycle.

## Why

Two long-lived clusters are needed for day-to-day work, and neither should depend on a rented
server:

| Cluster | Replaces | Purpose |
|---|---|---|
| **Local DEV** (1 node) | the remote single-node DEV server | follows the `development` branch through Flux; every push to `development` lands within a minute — the place a change is first seen running |
| **Local staging** (3 servers + optional worker) | the retired remote staging cluster | installed exactly like production, at production's version; release candidates reach it through the same signed-release path production takes, so every RC is an in-place upgrade test |

Throw-away runs (`run.sh`) stay for what they are good at: proving that a *fresh install* works
(installer changes, OS matrix, the full integration suite on a clean cluster). The lab answers the
other question — *does the change work on a cluster that has been running, and does the upgrade work
from where production is*.

## Topology

```
                LAN router  ── static route 10.98.0.0/16 → <lab-host>, NAT to the internet
                    │
               <lab-host>  (libvirt/KVM; routes between the lab networks)
     ┌──────────────┼──────────────────────────┬──────────────────────────┐
 lab-svc 10.98.100.0/24      lab-dev 10.98.110.0/24         lab-stg 10.98.120.0/24
  svc     .10 (always on)     dev-1  .11 (always on)          stg-s1..s3 .11-.13 (on demand)
  runner  .11 (on demand)                                     stg-w1     .21 (optional)
```

| VM | vCPU / RAM / disk | Default state |
|---|---|---|
| `lab-svc` | 2 / 2 GB / 30 GB | always on, autostarts with the host |
| `lab-runner` | 2 / 2 GB / 20 GB | on demand (integration suites, browser checks) |
| `lab-dev-1` | 6 / 12 GB / 80 GB | always on, autostarts with the host |
| `lab-stg-s1..s3` | 4 / 6 GB / 60 GB each | on for release and multi-node work, stopped otherwise |
| `lab-stg-w1` | 4 / 6 GB / 40 GB | OS installed; joined and removed on demand |

Fixed addresses come from DHCP host reservations in each network's definition, keyed on a MAC
derived from the network and host octet, so a VM always gets the same address back. The third
octets (100+) stay clear of the throw-away tier, whose run networks use `10.98.<1..90>`.

**Operating systems.** Every cluster node runs a **random supported OS** (`lib/os-registry.sh` —
Debian, Ubuntu, Rocky, Alma, CentOS Stream), drawn once when the VM is created and kept for its
life, so a cluster is mixed the way real installs grow node by node. `LAB_NODE_OS` pins new nodes
to one OS when a failure needs to be reproduced. The services VM and the runner are infrastructure
and stay on one fixed OS (Debian).

### Why three networks

Each cluster runs its node firewall in `cidr` mode (`bootstrap.sh --cluster-network-cidr`): the
cluster's own subnet is trusted for control-plane traffic, everything else is not. Putting both
clusters on one subnet would make each trust the other's nodes and hide firewall bugs. Separate
routed subnets give the same picture as a real deployment — nodes on a network shared with other
hosts, isolated by their own firewall. The shared services sit on a third subnet that every
cluster reaches through the host's routing, so no VM needs two network cards.

## Networking

- **Routed, not NAT.** The libvirt networks use `<forward mode='route'/>`. The host does not
  masquerade; the LAN router holds a static route `10.98.0.0/16 → <lab-host>` and NATs the lab
  subnets to the internet like any LAN subnet. Verified 2026-10-08 with a responder on a routed
  test network: lab → internet works for ICMP and TCP with no masquerade rule on the host, which
  is only possible when the router routes the replies back and NATs the source.
- **Reachable from the LAN.** Browsers, mail clients and this repo's tooling reach lab addresses
  directly through that route. LAN clients see the lab's real addresses, and the lab sees the
  clients' real addresses (no NAT in between) — bans, WAF and rate limits behave as in production.
- **No libvirt DNS.** `<dns enable='no'/>` on every network: a host-wide resolver (AdGuard Home,
  pi-hole) commonly binds `*:53`, and libvirt's per-network dnsmasq then fails to start. DHCP stays
  on; DHCP option 6 hands out the svc resolver.
- **Names.** `lab-svc` runs the resolver for the lab apex (`<lab-apex>`): `dev.<lab-apex>` and
  `stg.<lab-apex>` are authoritative zones in its PowerDNS, everything else forwards upstream. The
  LAN resolver forwards `<lab-apex>` to it (conditional forwarding), so LAN clients resolve lab
  names too.
- **Remote access** (away from the LAN) is whatever reaches the LAN today — e.g. the operator's
  mesh VPN advertising the lab route. Nothing in the lab is exposed to the internet.

## Shared services VM (`lab-svc`)

One persistent VM, its own Docker, data under `/var/lib/lab/*` so a restart keeps everything:

| Service | Purpose |
|---|---|
| dnsmasq | resolver for every lab VM and the LAN's conditional forward: `<lab-apex>` → PowerDNS, rest → upstream |
| PowerDNS (authoritative + API) | one zone per cluster; registered in each cluster as its DNS provider, so the platform's own DNS write path is exercised |
| step-ca (ACME) | the lab certificate authority — see *Certificates* |
| versitygw (S3) | backup target, one bucket per cluster |
| SFTP, Samba | the other two backup-target protocols the rclone shim supports |
| apt-cacher-ng | apt cache for the lab VMs (falls back to the origin when down) |

The throw-away tier's services VM regenerates its credentials per run and is thrown away with it;
the lab's credentials are generated once and kept in the operator's lab state file (0600).

## Local DEV

- **Install:** `bootstrap.sh --env dev --domain dev.<lab-apex>` — Flux follows the `development`
  branch with the `development` overlay, the same source and overlay the remote DEV used.
  `build-deploy` pins images on every push to `development`; Flux pulls them through the registry
  mirrors. No inbound connection from CI is needed, so the lab can sit behind NAT.
- **Flux keeps running.** Unlike a throw-away run, the lab never stops Flux to make certificates
  stick; certificate settings must survive reconciliation (see *Certificates*).
- **DNS provider:** the svc PowerDNS, registered as the platform's provider group — the remote DEV
  never had one.
- **Backups:** the svc S3 bucket for DEV.
- **Sign-in:** Dex (the development overlay's test IdP), as before.
- **Mail:** inbound and outbound within the lab. There is no inbound mail from the internet and no
  internet scanner traffic — the realism the internet-facing DEV had is given up deliberately.

## Local staging

- **Install like production:** `bootstrap.sh --env production --release-tag <production's tag>` —
  signed release, `platform-ops`, the production overlay (no Dex), host-migrations converged by the
  node CLI.
- **Release candidates:** `auto_update_include_prereleases = true` (off by default in production).
  A cut RC then reaches staging through the same pull path production uses for a stable release:
  signed tag verified on the node, host-migrations, database migrations, image roll — in place,
  from production's version. That is the upgrade test, every time, without a fresh baseline.
- **Baseline:** between release cycles staging sits on the version production runs. After a stable
  release is pulled by production, staging follows.
- **Worker:** `lab-stg-w1` keeps its OS but is not part of the cluster by default. Both flows are
  the operator's, driven through the admin API over the cluster's ingress:
  - `lab.sh worker join` pre-enrols the node (`POST /admin/cluster/pending-peers`), fetches the
    admin panel's join script (`POST /admin/cluster/bootstrap-command/<name>`: the signed `insula`
    CLI of the cluster's release, verified against the key the cluster pins, then
    `insula bootstrap --join-as worker` with a short-lived token) and runs it on the node as root,
    as pasted. The one edit is the one the script's note asks for: the servers' private-network
    CIDR on the join line. Checked: the bootstrap transcript (log gate), join invariance, node
    hygiene, the node Ready, the platform's inventory, the pre-enrolment claimed.
  - `lab.sh worker leave` drains and deletes the node (`POST /admin/nodes/<name>/drain`, then
    `…/delete` — the host stays running, as the admin panel says), runs the runbook's host step
    (`k3s-agent-uninstall.sh`) and stops the VM. Checked: the node gone from Kubernetes, Longhorn
    and the inventory, every server Ready.
- **Integration suites** run from `lab-runner` against either cluster, as on the throw-away tier.
- **Post-deploy checks:** `lab.sh smoke dev|stg` runs the API smoke (`scripts/smoke-test.sh`) from
  `lab-svc` — lab names, lab CA — and the cluster-network smoke (`make smoke`) on the first server.

## Certificates

The lab apex is private, so no public CA can validate it. The lab runs its own ACME CA on `lab-svc`:

- **step-ca, not Pebble.** Pebble (the throw-away tier's CA) generates a new root on every restart:
  every issued certificate and every browser trust breaks with it. step-ca keeps its root under
  `/var/lib/lab/step`. The operator imports that root once on their devices.
- **Lifetime 90 days** (ACME provisioner claim), like Let's Encrypt, so renewal behaviour matches.
- **Installed with existing bootstrap flags:** `--acme-server https://ca.<lab-apex>/acme/acme/directory`
  (cert-manager's `acme-custom-http01` issuer, `CLUSTER_ISSUER_NAME` in `platform-cluster-config`,
  which Flux substitutes on every reconcile), `--acme-ca <root>` (trust for the CA's own TLS),
  `--trust-ca <root>` (platform pods trust the certificates the lab CA issues), and
  `--stalwart-acme-directory` (Stalwart's ACME provider — read-only once created, so the directory
  URL must never change: it is a name in the lab zone, not an address).
- **Durability under Flux** is a Phase 2 acceptance check: certificates issued by the lab CA must
  stay on it across Flux reconciles, platform-api restarts and the 5-minute reconciler ticks.

## Caches and mirrors

Every lab VM uses the host's caches when they answer and the origin when they do not:

| Cache | Where | Fallback |
|---|---|---|
| Registry pull-through mirrors (docker.io, ghcr.io, quay.io, registry.k8s.io) | the host (existing) | containerd falls back to the upstream registry on its own when a mirror does not answer |
| apt (Debian/Ubuntu nodes) | `lab-svc` (apt-cacher-ng) | apt proxy auto-detect: an unreachable proxy is skipped |

apt-cacher-ng only caches plain http, while Debian's images ship https sources; lab nodes switch
`deb.debian.org`/`security.debian.org` to http before their first package install (apt verifies every
package against the signed Release file, so http costs no integrity). dnf-family nodes fetch from
their distribution mirrors directly.

A fallback is silent by nature, and a silent fallback is a bandwidth bill nobody sees. `lab.sh
status` therefore reports which caches answer and whether the nodes are configured to use them;
`lab.sh up` warns (instead of failing, as the throw-away tier does) when a mirror is down.

The registry mirror configuration (`/etc/rancher/k3s/registries.yaml`) is written by the lab at VM
creation and rewritten after any platform reinstall on the same VM.

## Disk

- VM disks live in the harness's ext4 loop filesystem on the host (fast `fsync`; see
  `ensure_fast_disk`). It must hold the lab (~350 GB of virtual disk) next to any throw-away run.
- **Discard is on** (`discard='unmap'` on the qcow2 driver, `fstrim.timer` in the guests), so space
  freed inside a VM is returned to the loop filesystem. Without it qcow2 files only ever grow — a
  long-lived three-server run filled a 216 GB backing image on 2026-10-08 and libvirt paused the
  VMs on the failed write.

## Capacity

Host: 20 cores, 62 GB RAM, shared with other work. VMs hold their full allocation (guest page
cache keeps it; free-page reporting only returns truly free pages — measured: DEV's qemu at 12.3 of
12 GB). Always on: DEV + svc = 14 GB. Staging is 18 GB (3 × 6 GB) plus 6 GB for the worker.

**DEV and staging take turns.** The host holds one of them with the memory margin, not both:
`lab.sh up stg` stops a running DEV first and records that; `lab.sh down stg` starts DEV again;
`lab.sh up dev` is refused while staging runs. Every start also refuses when the host's available
memory minus the VMs' ceilings would drop below the margin (default 8 GB).

## Operator prerequisites

1. A static route on the LAN router: `10.98.0.0/16 → <lab-host>`, with the router NATing it to the
   internet (most routers do for any routed internal subnet — the Phase 0 check proves it).
2. Conditional forwarding of `<lab-apex>` on the LAN resolver to the svc address — an upstream
   entry such as AdGuard's `[/<lab-apex>/]<svc-ip>`, NOT a DNS rewrite: a rewrite answers every lab
   name with the svc address, while each cluster's names must reach that cluster.
3. The lab CA root imported on the operator's devices (once; `lab.sh ca-root` prints it).

## Lifecycle — `scripts/vm-integration-tests/lab.sh`

| Command | Does |
|---|---|
| `lab.sh up svc` | networks + the services VM (idempotent) |
| `lab.sh up dev` / `lab.sh up stg` | create the cluster if it does not exist, otherwise start it; `up stg` stops DEV first |
| `lab.sh down dev` / `lab.sh down stg` | stop (VMs, OS and platform kept); `down stg` starts DEV again |
| `lab.sh worker join` / `worker leave` | add or remove `lab-stg-w1` through the platform's flows |
| `lab.sh smoke dev\|stg [api\|network]` | API smoke + cluster-network smoke against a running cluster |
| `lab.sh status` | VMs, addresses, cluster health, cache status |
| `lab.sh ca-root` | print the lab CA root for import |

Configuration: `scripts/vm-integration-tests/lab.env` (operator-local, git-ignored), from
`lab.example.env`. State (service credentials, admin passwords): `~/.config/insula/lab-state.env`, 0600.

Lab VMs are named `lab-*`; throw-away runs are `vmt-<run>-*` on `10.98.<1..90>` octets that skip the
lab's. `run.sh` stops older throw-away runs before it starts — it never touches `lab-*`.

## Phases

| Phase | Content | Status |
|---|---|---|
| 0 | Routed networking through the LAN router; reachability from the operator's tooling | verified (lab → internet, tooling → lab, a LAN laptop → DEV by name through the LAN resolver's forward) |
| 1 | `lab.sh`: config, three routed networks, the persistent services VM (PowerDNS zones, step-ca, S3, apt cache), DEV create/start/stop, discard | done — services VM and DEV built and checked live |
| 2 | Certificates durable under Flux; CA trust in every platform component that makes outbound TLS calls | done for the install path — Flux running, all public certificates (incl. mail) from the lab CA; `bootstrap.sh --trust-ca` now seeds Stalwart's trust too |
| 3 | DEV parity checklist (smoke test, browser sign-in, Flux auto-deploy of a real push, mail, backups, DNS provider, Dex); run beside the remote DEV for a few days | done (smoke 46/0, browser, auto-deploy of a real push, mail TLS, backups, DNS) — soak running |
| 4 | Staging: production-mode install at production's version, prerelease opt-in, worker join/leave; first job — the next release candidate | done. Install: 3 servers (Ubuntu 24.04 / Debian 12 / Rocky 9) at v2026.10.6. Worker (Debian 12) joined and removed through the admin flows, also on the reused VM. First RC: v2026.10.7-rc.1 applied in place from v2026.10.6 through the admin panel's update (browser) — DB migrations 0150–0153, host-migration 2026.10.7/0001 on every node, mail certificate from the lab CA, smoke API 46/0 and cluster network green, worker join/leave on the RC with the Longhorn node removed by the platform |
| 5 | Cutover: docs (ADR-053's DEV description, this tier's docs), retire the remote DEV server | docs done (ADR-053 amendment); nothing in CI talks to the remote DEV, so retiring it is the operator cancelling the server |

## Non-goals

- Exposing the lab to the internet. Internet-facing behaviour (real ACME HTTP-01, inbound mail from
  the internet, scanner traffic) is not reproduced locally.
- Replacing throw-away runs. Fresh-install fidelity stays with `run.sh`.
