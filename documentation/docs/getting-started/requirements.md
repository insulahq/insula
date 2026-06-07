---
verified: 2026.6.7
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

!!! tip "Add storage before adding nodes"
    When storage runs low but you still have CPU/RAM headroom, attaching a cloud
    volume as extra Longhorn disk is cheaper than a whole new node. HA and
    storage both scale incrementally.

## Supported operating systems

The installer (`bootstrap.sh`) detects your OS and **fails fast** on anything
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

Running `bootstrap.sh` installs and configures, on the node:

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
    - Optional `--with-monitoring` adds Prometheus + Loki + Grafana.
    - Authoritative sources:
      [INFRASTRUCTURE_SIZING.md](https://github.com/insulahq/insula/blob/main/docs/operations/INFRASTRUCTURE_SIZING.md),
      `check_os()` in
      [scripts/bootstrap.sh](https://github.com/insulahq/insula/blob/main/scripts/bootstrap.sh),
      [MAIL_SERVER_OPERATIONS.md](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_SERVER_OPERATIONS.md).
