---
verified: 2026.6.7
---

# Security hardening

Insula gives you a read-mostly **Posture** page that watches the security state
of your whole cluster — SSH exposure, mesh VPNs, firewall, certificate expiry,
backup encryption — and turns dangerous changes (like locking SSH to a VPN) into
guided runbooks rather than raw commands.

You find it at **Security → Posture** (`super_admin` only).

## The Posture page

The page is a set of tabs, driven by a per-node probe:

| Tab | What you see |
|---|---|
| **Overview** | Cluster summary: nodes with SSH publicly exposed, critical CIS failures, stale probes, plus Calico WireGuard, TLS-expiry, backup-health, audit-log-health, and reserved-hostname cards |
| **SSH Lockdown** | Per-node SSH posture and a "restrict to mesh" runbook |
| **Mesh Status** | Detected mesh provider per node (NetBird / Tailscale / WireGuard / none) and install snippets |
| **Firewall Posture** | nft sets, trusted-range and cluster-peer counts, public ports per node |
| **Node Hardening** | The per-node CIS-style check matrix |
| **K8s Posture** | Kubernetes-level posture checks |
| **Authentication** | Authentication-related posture |
| **Network Policies** | Network policy state |
| **Security Events** | Recent security-relevant audit-log rows |

Top-right: **Refresh probe** forces an early collect (~60 s); **Reload**
re-fetches the snapshot without restarting the probes.

!!! note "The probe only reads — it never changes your hosts"
    Posture data comes from a `security-probe` DaemonSet that mounts host paths
    **read-only**, drops all capabilities, and never mutates anything. Anything
    destructive (like SSH lockdown) is surfaced as a runbook you run yourself.

## CIS-style checks

The Node Hardening tab shows ten checks per node, including: `PermitRootLogin
no`, `PasswordAuthentication no`, an `AllowUsers` whitelist, recent boot / no
pending kernel update, presence of `fail2ban`/`sshguard` and unattended-upgrades,
and — the one critical check — **SSH not exposed to `0.0.0.0/0`**. When the probe
can't parse `sshd_config`, the SSH checks are marked non-passing rather than
falsely "secure".

## SSH-via-mesh lockdown

The biggest hardening win is removing SSH from the public internet and reaching
your nodes only over a VPN mesh (NetBird, Tailscale, or WireGuard) plus an
operator-IP fallback.

!!! danger "Get this wrong and you lose SSH to the node"
    Always confirm you have **console / KVM / cloud-rescue** access before
    locking down. The runbook modal makes you type the hostname and acknowledge
    console access before it reveals the command.

The flow (per node):

1. **Install a mesh provider** on the node (you choose; Insula doesn't bundle
   one) and verify you can `ssh root@<node-mesh-ip>`. The Mesh Status tab should
   then show your provider.
2. **Seed a fallback** in **Security → Network Trust → Trusted Ranges** — add
   your operator workstation IP (e.g. `203.0.113.5/32`). If the mesh ever drops,
   you can still SSH from a trusted range.
3. **Lock down** by re-running bootstrap with the mesh interface:
   ```bash
   bash bootstrap.sh --rejoin --ssh-via-mesh wt0    # or tailscale0, wg0
   ```
   This rewrites the firewall so port 22 is accepted only on the mesh interface
   **and** from your trusted ranges, persists the new posture, and reloads
   nftables. Existing SSH sessions stay up.
4. **Verify** — wait ~60 s, refresh Posture; the node's SSH badge flips from
   `public` to `mesh + trusted`, and a connection from the public IP is refused.

To undo it, re-run `bootstrap.sh --rejoin` **without** `--ssh-via-mesh`. Full
break-glass recovery (rescue mode, console) is in the
[Security Hardening runbook](https://github.com/insulahq/insula/blob/main/docs/operations/SECURITY_HARDENING.md).

!!! tip "Seed your trusted range *before* locking down"
    The mesh interface and the trusted-range fallback are both written into the
    SSH rule. Seeding your workstation IP first means a mesh-provider outage
    can't lock you out.

## Host-level fail2ban

The CIS checks flag whether `fail2ban` (or `sshguard`) is present on each node.
This is host-level brute-force protection for SSH, distinct from the
application-layer bans on the [Web defense](web-defense.md) page. Install it on
nodes the check flags as missing.

## The cluster firewall

Every node ships the same always-on **set-mode** nftables firewall. There is no
per-node SSH or firewall flag to manage after bootstrap — trust is driven by two
cluster resources you edit in the panel.

It's built from four nft sets:

| Set | Holds | Opens |
|---|---|---|
| `cluster_peers_v4` / `_v6` | Node internal IPs ∪ pre-authorised pending peers | Control-plane ports (`6443`, `8443`, `10250`, `5473`, `2379-2380`) |
| `trusted_ranges_v4` / `_v6` | Operator-blessed CIDRs | **All** TCP/UDP from those sources |

Control-plane ports are **never** open to `0.0.0.0/0` — only to cluster peers.
You manage both via **Security → Network Trust** (Trusted Ranges and Pending
Peers tabs); a reconciler converges them onto every node within ~30 s.

## Firewall blacklist

The **Security → Network Trust → Blacklist** tab lets you drop traffic from
specific IPs/CIDRs at the host firewall, cluster-wide
(`ClusterFirewallBlacklist`). A reconciler pushes an `nft` drop rule to every
node.

!!! warning "Self-lockout protection"
    The blacklist has two-layer protection so you can't accidentally cut off
    your own access — it refuses to blacklist a range that would lock you (or the
    cluster control plane) out.

??? info "Under the hood"
    The probe reads `sshd_config`, `/sys/class/net/*` (mesh interface
    detection), `/proc/net/nf_conntrack`, `/etc/hosting-platform/firewall.conf`,
    and binary presence — then writes one ConfigMap per node that the backend
    composes into the Posture snapshot. NetBird/Tailscale ship userspace
    WireGuard, so the Mesh tab can't report peer/handshake state for them (only
    kernel WireGuard populates `/proc/net/wireguard`). `--ssh-via-mesh` renders
    `iif "<iface>" tcp dport 22 accept` plus `trusted_ranges_v{4,6}` saddr
    fallbacks and persists `SSH_VIA_MESH=true`. CI guards
    (`ci-firewall-check.sh`, `test-ssh-via-mesh.sh`) enforce the rendering.
