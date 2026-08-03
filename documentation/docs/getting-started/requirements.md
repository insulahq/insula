---
verified: 2026.7.2
---

# Requirements

What you need before installing Insula: a supported server, a domain, DNS
access, and a handful of open ports.

## Server sizing

Insula is designed to start small and grow. A single node carries the whole
platform plus your first tenants.

| Stage | Nodes | Tenants | Notes |
|---|---|---|---|
| **Try it** | 1 × 4 GB RAM | a few | Enough to explore the panels |
| **Minimal (launch)** | 1 control plane + 1 worker (4 vCPU / 8 GB) | up to ~50 | Recommended starting point |
| **Small** | 1 control plane + 2 workers (4 vCPU / 8 GB) | up to ~100 | |
| **Medium** | 1 control plane + 2 workers (8 vCPU / 16 GB) | up to ~200 | |
| **HA** | 3 control plane + 3 workers (8 vCPU / 16 GB) | 300+ | Any single server can fail |

The reference single-node target is a **4 vCPU / 8 GB / 80 GB NVMe** VPS (e.g.
Hetzner CX32): the full platform plus ~10 starter tenants fits with headroom.
Because tenant pods request little (≈50m CPU / 64Mi each on Starter) and can
scale to zero when idle, a single 4 vCPU / 8 GB worker comfortably hosts ~50
starter sites.

Two memory notes for capacity planning:

- **Each node reserves ~1.28 GB of RAM** for the OS and the Kubernetes
  machinery (so tenant load can never starve the node itself). An 8 GB node
  offers roughly 6.7 GB to workloads; on a 4 GB "try it" node the reservation
  is proportionally chunky — fine for evaluation, tight for production.
- **Don't provision swap.** The installer disables it and keeps it off:
  Kubernetes nodes run swap-less so memory pressure resolves as a fast,
  visible pod eviction (tenants first, platform last) instead of node-wide
  thrashing. See
  [how nodes behave under memory pressure](../operator/nodes-and-cluster.md#how-nodes-behave-under-memory-pressure).

!!! tip "Add storage before adding nodes"
    When storage runs low but you still have CPU/RAM headroom, attaching a cloud
    volume as extra Longhorn disk is cheaper than a whole new node. HA and
    storage both scale incrementally.

## Supported operating systems

The installer (`insula bootstrap`) detects your OS and **fails fast** on anything
unsupported. These are the exact tiers it accepts:

=== "Tier 1 (CI-tested)"

    - **Debian 12** (bookworm), **Debian 13** (trixie)
    - **Ubuntu 22.04 LTS** (jammy), **Ubuntu 24.04 LTS** (noble)

=== "Tier 2 (best-effort)"

    - **RHEL 9**, **Rocky Linux 9**, **AlmaLinux 9**
    - **CentOS Stream 9** and **CentOS Stream 10**
    - **Amazon Linux 2023**

The installer **rejects** (aborts on):

- CentOS Linux 7 / 8 (end-of-life)
- Ubuntu older than 22.04, Debian older than 12
- Amazon Linux 2 (EOL 2026-06-30)
- Alpine, Talos, Flatcar, NixOS, or anything without systemd

Debian/Ubuntu use `apt`; RHEL-family and Amazon Linux 2023 use `dnf`. The
installer handles the difference automatically.

## Tools you need on the server

The installer carries everything it deploys and pulls its own OS packages, so
there is nothing to install *for* it. But three commands must already exist to
**download and verify the `insula` binary itself**, before it can run:

| Tool | Needed for | Preinstalled? |
|---|---|---|
| `curl` | Fetching the binary, its `.sig`, and the trust anchor | Ubuntu / RHEL-family / Amazon Linux: yes. **Minimal Debian and container-style images: often not.** |
| `openssl` | Verifying the signature before you run it | Yes, on every supported OS |
| `base64` | Decoding the signature (part of GNU coreutils) | Yes, on every supported OS |

If `curl` is missing (or HTTPS fails with a certificate error, which means
`ca-certificates` is missing):

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y curl ca-certificates openssl

# RHEL / Rocky / AlmaLinux / CentOS Stream / Amazon Linux 2023
sudo dnf install -y curl ca-certificates openssl
```

!!! tip "`cosign` is **not** required"
    Release signatures are ordinary ECDSA-P256-over-SHA-256 signatures, so
    `openssl` verifies them — which is exactly what each node does for every
    self-upgrade. Installing the 100 MB cosign binary on a server is optional;
    see [verify the download](install.md#verify-the-download).

## Network prerequisites

### A domain and DNS

- A **domain you control** for the platform (e.g. `hosting.example.com`), with
  DNS records you can edit.
- Point the platform subdomains at the server's IP. After install the panels
  live at `admin.<domain>`, `tenant.<domain>`, and `api.<domain>`.
- An **email address** for Let's Encrypt registration.

### Ports

| Port(s) | Purpose |
|---|---|
| **80, 443** | Web traffic + ACME HTTP-01 (Traefik ingress) |
| **22** | SSH (you can later restrict this to a private mesh) |
| **6443 / 8443 / 10250 / 2379–2380 / 5473** | Cluster control plane — scoped to cluster peers + trusted ranges, never open to the world |

If you'll run email, the mail server also needs the standard mail ports open
(25, 465, 587, 143, 993, 110, 995, and optionally 4190). On some cloud
providers outbound port 25 is blocked by default and must be unblocked or
routed via a relay — see the mail operations guide.

!!! warning "Control-plane ports are never world-open"
    Insula's firewall scopes the cluster control-plane ports to known peers and
    operator-trusted source ranges. Seed your workstation/LAN with
    `--allow-source` at install time so `kubectl` works before the admin panel
    exists.

## What gets installed

Running `insula bootstrap` installs and configures, on the node:

- **k3s** (lightweight Kubernetes) + **Calico** CNI
- **Traefik v3** ingress (ports 80/443) with CrowdSec + ModSecurity-CRS
- **cert-manager** (Let's Encrypt staging + production)
- **Sealed Secrets** and **Flux v2** (GitOps)
- Platform namespaces, RBAC, network policies, and a host firewall
- The platform itself (API, admin/tenant panels, database, mail), reconciled by
  Flux
- An initial admin login and an encrypted Tier-1 secrets bundle

??? info "Under the hood"
    - The platform database is **PostgreSQL via CloudNativePG**; the platform
      cache is in-memory (no Redis). Storage is **Longhorn** (single-node falls
      back to local-path when `--skip-longhorn` is used).
    - Monitoring is built in (a single lightweight VictoriaMetrics pod + an
      in-platform SLO evaluator) — no separate monitoring stack to install.
    - Authoritative sources:
      [INFRASTRUCTURE_SIZING.md](https://github.com/insulahq/insula/blob/main/docs/operations/INFRASTRUCTURE_SIZING.md),
      `check_os()` in
      [scripts/bootstrap.sh](https://github.com/insulahq/insula/blob/main/scripts/bootstrap.sh),
      [MAIL_SERVER_OPERATIONS.md](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_SERVER_OPERATIONS.md).
