# Local VM Lab — retained DEV and staging clusters on one host

> **Status:** in progress — design agreed, Phase 0 (networking) verified, Phase 1 under way.
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
| `lab-stg-s1..s3` | 4 / 8 GB / 60 GB each | on for release and multi-node work, stopped otherwise |
| `lab-stg-w1` | 4 / 8 GB / 40 GB | OS installed; joined and removed on demand |

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
- **Worker:** `lab-stg-w1` keeps its OS but is not part of the cluster by default. `lab.sh worker
  join` pre-enrolls it (`ClusterPendingPeer`) and joins it with `bootstrap.sh --join-as worker`;
  `lab.sh worker leave` removes it through the platform's node-removal flow. Both flows get
  exercised whenever the worker is used.
- **Integration suites** run from `lab-runner` against either cluster, as on the throw-away tier.

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

Host: 20 cores, 62 GB RAM, ~22 GB used by the host's own services. Always on: DEV + svc ≈ 14 GB
(ceilings). Staging adds 24 GB (+8 worker, +2 runner) while it runs. Free-page reporting and KSM
return well below the ceilings in practice, but staging stays on-demand, and `lab.sh up stg`
refuses to start when the host's available memory minus staging's ceilings would drop below the
margin (default 8 GB).

## Operator prerequisites

1. A static route on the LAN router: `10.98.0.0/16 → <lab-host>`, with the router NATing it to the
   internet (most routers do for any routed internal subnet — the Phase 0 check proves it).
2. Conditional forwarding of `<lab-apex>` on the LAN resolver to the svc address.
3. The lab CA root imported on the operator's devices (once; `lab.sh ca-root` prints it).

## Lifecycle — `scripts/vm-integration-tests/lab.sh`

| Command | Does |
|---|---|
| `lab.sh up svc` | networks + the services VM (idempotent) |
| `lab.sh up dev` / `lab.sh up stg` | create the cluster if it does not exist, otherwise start it |
| `lab.sh down dev` / `lab.sh down stg` | stop (VMs, OS and platform kept) |
| `lab.sh status` | VMs, addresses, cluster health, cache status |
| `lab.sh worker join` / `worker leave` | add or remove `lab-stg-w1` through the real flows |
| `lab.sh ca-root` | print the lab CA root for import |

Configuration: `scripts/vm-integration-tests/lab.env` (operator-local, git-ignored), from
`lab.example.env`. State (service credentials, admin passwords): `~/.config/insula/lab-state.env`, 0600.

Lab VMs are named `lab-*`; throw-away runs are `vmt-<run>-*` on `10.98.<1..90>` octets that skip the
lab's. `run.sh` stops older throw-away runs before it starts — it never touches `lab-*`.

## Phases

| Phase | Content | Status |
|---|---|---|
| 0 | Routed networking through the LAN router; reachability from the operator's tooling | verified (lab → internet, tooling → lab); LAN-client check pending |
| 1 | `lab.sh`: config, three routed networks, the persistent services VM (PowerDNS zones, step-ca, S3, apt cache), DEV create/start/stop, discard | done — services VM and DEV built and checked live |
| 2 | Certificates durable under Flux; CA trust in every platform component that makes outbound TLS calls | done for the install path — Flux running, all public certificates (incl. mail) from the lab CA; `bootstrap.sh --trust-ca` now seeds Stalwart's trust too |
| 3 | DEV parity checklist (smoke test, browser sign-in, Flux auto-deploy of a real push, mail, backups, DNS provider, Dex); run beside the remote DEV for a few days | — |
| 4 | Staging: production-mode install at production's version, prerelease opt-in, worker join/leave; first job — the next release candidate | — |
| 5 | Cutover: docs (ADR-053's DEV description, this tier's docs), retire the remote DEV server | — |

## Non-goals

- Exposing the lab to the internet. Internet-facing behaviour (real ACME HTTP-01, inbound mail from
  the internet, scanner traffic) is not reproduced locally.
- Replacing throw-away runs. Fresh-install fidelity stays with `run.sh`.
