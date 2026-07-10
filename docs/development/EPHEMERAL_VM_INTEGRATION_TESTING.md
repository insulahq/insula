# Ephemeral VM Integration Testing (Unraid / libvirt)

> **Status:** DESIGN — scripts scaffolded under `scripts/vmtest/`, NOT yet wired to live
> orchestration (needs one operator enablement step, below).
> **Last updated:** 2026-07-10
> **Supersedes for the *test* use case:** [`LOCAL_MULTINODE_VM_SETUP.md`](./LOCAL_MULTINODE_VM_SETUP.md)
> describes a **persistent dev-iteration** cluster (keep-the-VMs, `br0`+DHCP). This doc is the
> **throw-away, fresh-per-run integration-test** substrate. They share the same machinery
> (`virsh` + cloud-init + `bootstrap.sh` verbatim); the difference is lifecycle.
> **Related:** [`INTEGRATION_TESTS.md`](./INTEGRATION_TESTS.md), [`TESTING_STRATEGY.md`](./TESTING_STRATEGY.md),
> `scripts/integration-all.sh`, `scripts/bootstrap.sh`.

---

## Why this exists

`scripts/integration-all.sh` is only trustworthy against a substrate that behaves like
production. Two facts force the design:

1. **~half the suite is host/kernel-bound.** Of 73 `integration-*.sh` suites, **37 SSH into a
   real node**, 15 exercise **Longhorn** (block devices/iSCSI), 11 run the **host-config
   converger / host-migrations**, 9 drive **`bootstrap.sh`**, 9 do **multi-node drain/topology**,
   5 touch the **nftables firewall**, 3 use **node-terminal** (`nsenter` into PID-1). DinD gives
   *none* of these faithfully — no systemd/init, no real block devices, no netns firewall
   isolation, and "PID 1" is the container, not a host. Hardening DinD toward this fights the
   substrate (see the M14 "5 cascading bugs" incident).

2. **The flakiness we chased for days was cross-run state leak on a *long-lived* cluster** (see
   `project_integration_state_isolation_2026_07_10`). Staging is never wiped between runs, so a
   suite that mutates shared state poisons the next run. **A fresh VM per run has zero
   accumulated state** — it turns the isolation fixes from load-bearing into belt-and-suspenders,
   and is the structural cure for "passes standalone, fails in the full run."

**DinD is not deprecated.** It stays the *app inner loop* (Tier 0). This tier is the *integration
gate* (Tier 1). Match the substrate to what each can honestly do.

## Tier map

| Tier | Substrate | Covers | Cold time | Runs where |
|---|---|---|---|---|
| **0 — DinD / k3d** (exists) | single k3s-in-Docker | app inner loop + API-only suites (tenant/domain/db/mail-admin/webmail-settings/catalog) | ~20s | sandbox / CI (fast) |
| **1 — Ephemeral VMs** (this doc) | 1–4 throw-away KVM VMs, `bootstrap.sh` verbatim | **full `integration-all`** incl. bootstrap → host-migrations → Longhorn → firewall → node-terminal → HA/drain/multi-node | 3–6 min | Unraid host, nightly + on-demand |
| **2 — Remote staging** (exists) | real VPS, real DNS/TLS/NetBird | final pre-prod parity, real external integrations | push+wait | cloud |

---

## The throw-away model

```
os-images.sh   (once, cached/OS)      spawn-cluster.sh (per run)         teardown.sh (per run)
──────────────────────────────       ──────────────────────────         ────────────────────
per-OS cloud image (registry)         qcow2 OVERLAY per VM  ────┐         virsh destroy + undefine
  + cloud-init (ssh key, qemu-guest    (backing = golden,        │          --remove-all-storage (all
    -agent, growpart)                   copy-on-write, ~seconds)  │          domains incl. services VM)
  → golden-<os>.qcow2 ◀ backing ───────────────────────────────┘        rm overlays/ ; net-destroy
                                       + 1 services VM (own Docker:        (no host Docker to clean)
  (optional) --warm: snapshot AFTER    DNS/ACME/S3); random OS/node        (trap EXIT → always cleans)
   bootstrap → skip 5-min install       run bootstrap.sh --remote
   for app-tier runs                    → wait k3s ready
```

- **Overlay clones** (`qemu-img create -f qcow2 -b golden.qcow2 overlay.qcow2`) make spawn and
  teardown seconds, not minutes — the golden image is read-only backing; each VM writes only its
  delta; teardown is `rm overlay.qcow2`.
- **`--cold` (default):** boot clean base, run `bootstrap.sh` end-to-end → exercises bootstrap +
  host-migrations for real. **`--warm`:** boot from a post-bootstrap snapshot → skips the install,
  for fast app/host-migration-only runs. Cold is the fidelity gate; warm is the quick loop.
- **Per-run NAT network** (`insula-test-<runid>`, isolated /24) so parallel runs never collide and
  teardown is total. (The persistent-dev doc uses `br0`+DHCP; for throw-away isolation a per-run
  NAT net is cleaner.)

---

## Driver abstraction (resolves the "sandbox has no KVM" blocker)

This sandbox has **no `/dev/kvm`** — but it doesn't need it. KVM runs on the Unraid host; the
sandbox is only the libvirt *client*. `scripts/vmtest/lib/driver.sh` abstracts the transport so
the enablement choice is a one-line config, and the rest of the tooling is transport-agnostic:

| `VMTEST_DRIVER` | How | Enablement (operator, one-time) |
|---|---|---|
| `libvirt-sock` | `virsh -c qemu:///system` over the mounted host socket | bind-mount `/var/run/libvirt/libvirt-sock` into the sandbox + `apt install libvirt-clients qemu-utils` |
| `ssh-host` | SSH to the Unraid host, run `virsh`/`virt-install` there | give the sandbox an SSH key to the Unraid host |

Both put QEMU/KVM on the host; neither needs nested virt. Pick at enablement time — the design
and all scripts below work unchanged with either.

Driver contract (functions every backend implements):

```
vm_net_create <run> <cidr>        vm_net_destroy <run>
vm_create <name> <overlay> <mac> <net> <vcpu> <ram_mb>
vm_ip <name>                      vm_ssh <ip> <cmd...>
vm_wait_ssh <ip> <deadline_s>     vm_destroy <name>
img_clone <golden> <overlay>      img_snapshot <name> <tag>   (warm mode)
```

The DNS/ACME/S3 services are **NOT** host containers — see below. There is no
`svc_run`/host-Docker verb: **libvirt is the only host privilege the rig needs.**

---

## DNS + Let's Encrypt (self-contained, no rate limits)

The platform **already overlay-switches ClusterIssuers** (`letsencrypt-staging-http01`,
`letsencrypt-prod-dns01-powerdns`, …). Adding a `pebble-*` issuer is one manifest.

**Where these run — NOT the host's Docker.** PowerDNS, Pebble, and MinIO run in a small
**throw-away services VM's own Docker** (`net-services.sh`), on the run's NAT net. Using the
host's Docker would need `docker.sock` (root-equivalent) and wouldn't share the host-libvirt
VMs' network anyway; a services VM is isolated *and* network-coherent, and dies with the run. So
the rig needs **no host Docker at all — libvirt is the only host privilege.** (RAM-saving
alternative: `VMTEST_SVC_MODE=colocate` runs this Docker on the control-plane VM instead of a
dedicated one.) Two fidelity tiers:

| Tier | ACME CA | DNS | Use | Rate limit |
|---|---|---|---|---|
| **fast** (default, every run) | **Pebble** (in the services VM) test CA | **PowerDNS** (in the services VM), authoritative for the apex + resolver for the VM net | every ephemeral run | none |
| **fidelity** (nightly/weekly) | **LE staging** endpoint | PowerDNS on a *publicly-delegated* subzone, real DNS-01 | catch real ACME/DNS-01 quirks | LE-staging (generous) |

- **PowerDNS** (`scripts/vmtest/net-services.sh`) is authoritative for the run's apex (e.g.
  `t<runid>.insula.test`) **and** is set as the VMs' resolver (cloud-init `/etc/resolv.conf`), so
  `admin.<apex>`, `mail.<apex>`, `*.ingress.<apex>` resolve internally. The platform's DNS
  provider group points at this PowerDNS REST endpoint — exercising the real record-CRUD path.
- **Pebble** (`letsencrypt/pebble`) issues certs with no rate limit and no public reachability;
  its ACME directory is fed to a `pebble-http01` / `pebble-dns01` ClusterIssuer overlay. The
  Pebble CA cert becomes `CURL_CA_BUNDLE` for the suites (so `curl`/`openssl` asserts trust the
  chain) — or `CURL_INSECURE=1` for the quick path.
- **Never real production LE in CI** — only Pebble (fast) or LE-staging (fidelity).

---

## Wiring into the existing harness (near-zero suite changes)

`integration-all.sh` is already fully env-driven. The VM tier just provisions, then exports the
**same contract the DEV/staging runs use** and calls it:

```
SSH_HOST=root@<cp-ip>   SSH_KEY=<ephemeral key>   KUBECTL=<remote-kubectl wrapper>
DOMAIN=admin.<apex>     API_BASE=https://admin.<apex>   PLATFORM_API_URL=…
ADMIN_EMAIL / ADMIN_PASSWORD    CURL_CA_BUNDLE=<pebble-ca> | CURL_INSECURE=1
```

`scripts/vmtest/run.sh` sets these, runs the host-config converger preflight + **baseline gate**
(both already in `integration-all.sh`), then the suites, and writes `--report-json`. On a fresh
cluster the baseline gate should always report *no drift* — if it ever reports drift on a
brand-new VM, that's a **real bug** (bootstrap/host-migration left the cluster non-canonical),
exactly the signal we want.

---

## Multi-OS compatibility (what VMs uniquely unlock)

The platform supports a matrix (CLAUDE.md → *Supported OSes*): **Tier-1** Debian 12/13,
Ubuntu 22.04/24.04 LTS; **Tier-2** RHEL/Rocky/Alma 9, CentOS Stream 9/10, Amazon Linux 2023.
`bootstrap.sh` dispatches `apt` vs `dnf` by `OS_FAMILY` and fails fast on EOL.

`scripts/test-bootstrap-os-matrix.sh` already covers this **in containers** — but a container
can only prove the *dispatch logic* (`check_os`, apt-vs-dnf branch selection). It cannot boot a
real kernel, run systemd, install k3s, mount Longhorn, or apply host-migrations. **The VM tier
is the only place the full install is proven per OS.**

**Strategy: random OS per node — no fixed set, never all-at-once.** Every node in a run draws a
random OS from the supported pool (`lib/os-registry.sh`), so a single run is a **heterogeneous
cluster** — e.g. a Debian control-plane with Rocky + Ubuntu + Alma workers. That is both:

- a **real-world scenario** — operators add nodes over time on whatever OS is current, so mixed-OS
  clusters happen in production and deserve direct testing; and
- **statistically self-covering** — over many runs the draws sample the whole matrix, so coverage
  accumulates without any run paying for all 8 (which a fixed exhaustive sweep would).

**PR, nightly, and pre-release all use this same random-per-node model.** They differ only in
node count / suite scope / how many runs — *not* in OS strategy. More nodes and more nightly runs
simply sample more of the matrix faster.

Mechanics:
- `lib/os-registry.sh` maps each supported OS id → its **stock generic cloud image** (no baked
  content — `bootstrap.sh` does the install, so the real per-OS path runs). Amazon Linux 2023 has
  no stable `latest` symlink, so its URL is a `PIN_…` placeholder excluded from the pool until filled.
- `spawn-cluster.sh` draws a random OS per node from `VMTEST_OS_POOL` (empty ⇒ **all** supported
  OSes) and fetches only the goldens it drew. Root login is enabled uniformly by the cloud-init
  seed, so `bootstrap.sh --remote` (SSHes as root) works on every family; bootstrap auto-detects
  `OS_FAMILY` itself.
- **Reproducible:** the draw is seeded. `spawn-cluster` prints `os-seed=<n>` and the full
  assignment (`cp1=debian-13  w1=rocky-9  …`); a failed `run.sh` echoes the exact
  `VMTEST_OS_SEED=<n>` to replay that same cluster. Pin every node to one OS with `VMTEST_OS=<id>`
  (or `run.sh --os <id>`) to isolate an OS-specific bug.

## Layout

```
scripts/vmtest/
  README.md                 # quickstart + enablement
  config.example.env        # tunables (driver, OS, matrix, node count, ACME, backup)
  lib/
    os-registry.sh          # supported-OS → stock cloud-image map (the matrix)
    driver.sh               # libvirt-sock | ssh-host backends (the contract above)
    waitfor.sh              # wait-for-ssh, wait-for-k3s-ready, wait-for-flux
  os-images.sh              # fetch/cache golden base image(s) (list|<os>|all=pool)
  net-services.sh           # per-run NAT net + services VM (own Docker: PowerDNS/Pebble/MinIO)
  spawn-cluster.sh          # draw a RANDOM OS per node, overlay-clone, bootstrap.sh --remote
  run.sh                    # one run: net→spawn(mixed-OS)→integration-all→report→teardown
  teardown.sh               # throw everything away (trap-safe)
```

All pins (`K3S_VERSION`, `LONGHORN_VERSION`, `TRAEFIK_CHART_VERSION`, …) are **read from
`scripts/bootstrap.sh` at run time**, never hardcoded here — that is the lesson from the stale
persistent-dev doc (which still lists a long-gone `INGRESS_NGINX_CHART_VERSION`; the platform is
Traefik). `bootstrap.sh` runs *verbatim* inside each VM, so local↔staging drift is zero by
construction.

---

## Phased implementation

- **P0 — single node, cold.** `build-golden.sh` + `driver.sh` (one backend) + `spawn-cluster.sh`
  for 1 server + `bootstrap.sh --cold` + `make smoke`. Proves the substrate.
- **P1 — full gate.** Multi-node (server + workers via `--join-as worker` + `ClusterPendingPeer`
  pre-enroll), Longhorn on virtual disks, PowerDNS+Pebble, MinIO backup target, `run.sh` →
  full `integration-all` green.
- **P2 — automation.** Nightly cron on the Unraid host (or a self-hosted GH runner) → cold full
  run + weekly LE-staging fidelity run; upload the report JSON. PR tier stays Tier 0 (fast).

## Resource budget

Per the persistent-dev doc's headroom (10 VM slots on Unraid): a run uses **1 server + 3 workers**
(2 vCPU / 4 GB / 40 GB each ≈ 8 vCPU, 16 GB, on overlays that start near-zero and grow). Ephemeral
→ reclaimed on teardown, so no standing commitment. `--warm` single-node runs use ~2 vCPU / 4 GB.

## Non-goals

- Not replacing DinD (Tier 0) or staging (Tier 2) — three tiers, distinct jobs.
- Not cross-platform — Unraid/libvirt only.
- Not a persistent dev cluster — that's [`LOCAL_MULTINODE_VM_SETUP.md`](./LOCAL_MULTINODE_VM_SETUP.md).
- No live orchestration until the operator picks a `VMTEST_DRIVER` enablement path.
