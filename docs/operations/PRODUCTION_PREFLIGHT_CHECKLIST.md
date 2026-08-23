# Production Pre-Flight Checklist

> **Use**: fill this out *before* the first `insula bootstrap --env production`.
> Production is unforgiving — real customers, real data, real mail reputation.
> Every unchecked box is a reason the cutover could fail at 3am.
>
> **Companion docs**: [`DEPLOYMENT_RUNBOOK.md`](./DEPLOYMENT_RUNBOOK.md) (full
> procedure) · [`DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md) ·
> [`SECRETS_LIFECYCLE.md`](./SECRETS_LIFECYCLE.md) ·
> [`MAIL_SERVER_OPERATIONS.md`](./MAIL_SERVER_OPERATIONS.md) ·
> [`CLUSTER_NETWORK.md`](./CLUSTER_NETWORK.md) ·
> [`HA_MODE`](../architecture/HA_MODE.md) ·
> [`PLESK_MIGRATION.md`](./PLESK_MIGRATION.md) (only if migrating).
>
> This doc is the distilled **go / no-go**. Unlike staging, production has no
> "fix it live" — treat any unresolved box as a hard stop.

---

## 1. Release selection — **stable tag only**

Production pins Flux's GitRepository to an immutable, **cosign-signed release
tag**, never a branch. It **refuses `-rc.N`** by design (the CalVer tag regex
excludes prereleases) — a release candidate cannot bootstrap production.

- [ ] Chosen release tag: `v__________` (must be a **stable** `vYYYY.M.PATCH`, no `-rc`)
- [ ] That tag exists on the remote: `git ls-remote --tags origin | grep v<version>`
- [ ] A GitHub Release exists for it with **signed** assets attached
      (`insula-linux-{amd64,arm64}` + `.sig`, `release-manifest.json` + `.sig`)
- [ ] The same tag has been **proven green on staging** (staging auto-follows the
      newest tag; confirm its last full integration sweep passed on this version)
- [ ] Release notes / CHANGELOG reviewed for any `### BREAKING` section

## 2. Servers & capacity

- [ ] Node count decided: **1** (single-node) or **≥ 3 servers** (HA — never 2; etcd needs a majority)
- [ ] Public IPv4 (per node): `______._____._____._____`  ·  IPv6 (if dual-stack): `____________`
- [ ] Minimum specs per node met: ≥ 4 vCPU / 8 GB RAM / 80 GB SSD (more for real tenant load)
- [ ] OS is Tier-1 supported: Debian 12/13 or Ubuntu 22.04/24.04 LTS (Tier-2: RHEL/Rocky/Alma 9, Amazon Linux 2023)
- [ ] Kernel has iSCSI + NFS modules for Longhorn (`lsmod | grep -E 'iscsi|nfs'`)
- [ ] **Swap is off** (`swapoff -a` + fstab) — kubelet memory eviction assumes swapless nodes
- [ ] SSH reachable as a passwordless-sudo user (or root): `ssh <user>@<ip> uptime`
- [ ] Fresh host — no pre-existing `/etc/insula`, `/var/lib/insula`, or `/var/lib/rancher/k3s` state
- [ ] **No leftover Longhorn iSCSI sessions** (only matters when REINSTALLING on hardware that
      previously ran the platform and has not been rebooted):
      `iscsiadm -m session | grep -c iqn.2019-10.io.longhorn:` should be `0` on a host with no
      cluster. Sessions survive a wipe — nothing logs them out unless the teardown went through
      `scripts/destroy-cluster.sh` — and each orphan then retries login ~1/s forever against
      whatever now owns the old portal IP, flooding the kernel log (measured: ~3100 msgs/min on an
      otherwise idle node) and spawning `scsi_eh` threads. Clear with
      `iscsiadm -m session -u` **on a host with no live volumes**, or reboot.

## 3. DNS (propagated, verified from a public resolver)

Production system hostnames — **every line must return the ingress IP**. Note
there is **no `dex.` record** in production (Dex is dev/staging only).

```bash
APEX=hosting.example.com          # your production apex
for host in $APEX \
            admin.$APEX \
            tenant.$APEX \
            webmail.$APEX \
            mail.$APEX \
            stalwart.$APEX \
            random-$RANDOM.ingress.$APEX; do   # wildcard probe
  printf "%-45s → " "$host"; dig +short "$host" @1.1.1.1 | head -1
done
```

- [ ] Apex `<apex>` → ingress IPv4 (A) / IPv6 (AAAA) — apex uses A/AAAA, **never CNAME**
- [ ] `admin.`, `tenant.`, `webmail.`, `mail.`, `stalwart.` resolve to the ingress IP
- [ ] Tenant routes resolve directly: a route's hostname → ingress IP via its own `A`/`AAAA`
      (managed-mode routes get per-domain A/AAAA; the old `*.ingress.<apex>` chain is retired)
- [ ] TTLs low (≤ 5 min) during cutover so mistakes are cheap to fix
- [ ] Platform settings plan: `ingress_base_domain`, `ingress_default_ipv4/ipv6` will match the above

## 4. Mail deliverability — **production-critical, do this first**

A fresh IP with bad reverse DNS is blocklisted on day one and reputation is slow
to recover. See [`MAIL_SERVER_OPERATIONS.md § 2`](./MAIL_SERVER_OPERATIONS.md).

- [ ] **Outbound port 25 is unblocked** by the provider (many block it by default — open a ticket early)
- [ ] **PTR / reverse DNS (FCrDNS)** set for every sending IP → resolves to `mail.<apex>`, which forward-resolves back to the same IP
- [ ] Default provider rDNS (e.g. `*.your-server.de`) is **replaced** — never send from it
- [ ] SPF, DKIM, DMARC records planned/published for the apex and any customer mail domains
- [ ] Clean IP confirmed against major blocklists (`dig -x <ip>`; check Spamhaus etc.)
- [ ] Warm-up plan for outbound volume (R7 auto-warmup is **not built** — this is manual)
- [ ] **Multi-node mail exposure decided.** The default needs **no load balancer**: the HAProxy `hostNetwork` DaemonSet binds the public mail ports on nodes and DNS multi-A records handle failover. If you *do* front the cluster with an LB, it **MUST be L4 TCP passthrough that preserves the client source IP** — a SNAT'ing or L7 LB destroys the real sender IP for mail (HAProxy frontends don't `accept-proxy`, and Stalwart's PROXY-protocol trust is reconciler-managed to the pod CIDR with **no operator knob** to trust an external LB), which breaks SPF/DKIM alignment and reputation. MetalLB (universal) or a cloud CCM is only needed if you want a single external VIP for the `type: LoadBalancer` mail Service — and even then it must preserve source IP.

## 5. Signing & the pull model

- [ ] `platform/cosign.pub` in the bootstrapping checkout/binary is the **intended production trust anchor** (rotate off the W17 bring-up key before hardened production — see [`RELEASING.md`](../../RELEASING.md))
- [ ] Understood: `insula` self-upgrades daily as root and **fail-closes** on an unverified binary — a bad/rotated key stops upgrades, it does not run unsigned code
- [ ] The signed release for the chosen tag verifies locally: `openssl dgst -sha256 -verify platform/cosign.pub -signature <(base64 -d <asset>.sig) <asset>` → `Verified OK` (openssl needs no extra install and is the same check the node makes; with cosign it's `cosign verify-blob --key platform/cosign.pub --signature <asset>.sig --insecure-ignore-tlog=true <asset>`)

## 6. Secrets & encryption keys

Bootstrap auto-generates platform secrets, but two keys are the operator's to own:

- [ ] **Backup encryption** — supply your own recipient: `--operator-age-recipient age1...`, and the matching **private key is stored offline** (without it, backups are undecryptable — see [`SECRETS_LIFECYCLE.md`](./SECRETS_LIFECYCLE.md))
- [ ] **`PLATFORM_ENCRYPTION_KEY`** set on platform-api (AES-256-GCM) — **required** if you will run a Plesk migration; the dev fallback is insecure ([`PLESK_MIGRATION.md § Prerequisites`](./PLESK_MIGRATION.md))
- [ ] Plan to capture the seeded admin credentials the moment bootstrap prints them, then **remove `/etc/insula/admin-credentials`** after creating real admins
- [ ] Tier-1 age-encrypted secrets bundle destination understood (`/var/lib/insula/bundles/`); `make secrets-fetch HOST=…` tested from the ops workstation

## 7. Auth / IAM & feature flags

- [ ] **Admin-UI gate decision made**: default is the **cookie gate** (`admin-auth-gate-cookie`, operator decision 2026-07-24). Swapping to `admin-auth-gate-oauth2` + an **external** OIDC IdP is optional — in-cluster Dex is **not** available in production
- [ ] **Node terminal** is **ON** in production (`node-terminal-enabled: "true"`) — confirmed as intended (super_admin-only, step-up gated); disable only if policy forbids it
- [ ] External service endpoints ready and configured in the admin panel post-install: DNS provider group (PowerDNS/…), backup target, optional external OIDC

## 8. Backups & disaster recovery

- [ ] Backup target chosen and reachable (S3 bucket+creds, or SSH `user@host:/path`) — configure via Admin → Settings → Backup after install
- [ ] **DR restore rehearsed** on staging within the last release cycle (PITR + bundle restore reach healthy) — you have run [`DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md) at least once
- [ ] Snapshot/retention policy decided; you know how to enumerate snapshots + bundles **before** any destructive op

## 9. Network & firewall

- [ ] Firewall mode chosen: `single` (one node), `set` (HA, reconciled), or `cidr` (mesh/VLAN) — see [`CLUSTER_NETWORK.md`](./CLUSTER_NETWORK.md)
- [ ] Inbound allowed: `80/tcp`, `443/tcp`, mail (`25,465,587,143,993`), and `6443/tcp` scoped to peers (never `0.0.0.0/0`)
- [ ] **Multi-node:** every joining node's IP pre-enrolled via `--pre-enroll-peer <ip>` (first server) or the **`ClusterPendingPeer`** CR / admin UI — a manual `nft` edit is reverted within seconds
- [ ] Your workstation IP added via `--allow-source <ip>` so `kubectl`/SSH work before the admin panel exists
- [ ] **Fronting web with an LB/CDN?** Add its egress CIDR under **Security → Network Trust → Trusted Proxies** (admin UI) so Traefik + the panels honor its `X-Forwarded-For` and clients don't all appear as the LB IP. This is the **only** proxy-trust surface exposed to operators, and it applies to **web (XFF) only** — it does *not* configure PROXY-protocol trust for Traefik or anything on the mail path. A pure L4-passthrough LB (preserving client IP) needs no entry here.

## 10. Operator readiness

- [ ] [`DEPLOYMENT_RUNBOOK.md`](./DEPLOYMENT_RUNBOOK.md) read end-to-end in the last 7 days
- [ ] Rollback path understood (git/snapshot-based — production is not force-pushed to)
- [ ] Change window booked; out-of-band channel ready (phone/Signal) in case bootstrap breaks your SSH session
- [ ] A second operator is reachable for the duration

---

## Go / No-Go

**All boxes checked AND no unresolved concerns?** Download the signed binary on
the target (or drive `--remote` from your workstation) and run:

```bash
# On the target node — signed installer binary (ADR-055), no repo clone:
curl -fsSLO https://github.com/insulahq/insula/releases/latest/download/insula-linux-amd64

# Verify the signed binary BEFORE running it (production: do not skip).
# openssl is already on the node and needs no flags-of-shame; it is the exact
# check platform-ops makes on every self-upgrade. Must print "Verified OK".
curl -fsSLO https://github.com/insulahq/insula/releases/latest/download/insula-linux-amd64.sig
curl -fsSLO https://raw.githubusercontent.com/insulahq/insula/main/platform/cosign.pub
openssl dgst -sha256 -verify cosign.pub \
  -signature <(base64 -d insula-linux-amd64.sig) insula-linux-amd64
# With cosign instead: add --insecure-ignore-tlog=true (releases are signed with
# an offline key and are NOT in the Rekor transparency log, so cosign hard-fails
# without it and warns about skipping tlog with it — both are expected).

chmod +x insula-linux-amd64 && sudo mv insula-linux-amd64 /usr/local/bin/insula

sudo insula bootstrap \
  --env production \
  --release-tag v<version> \
  --domain <apex> \
  --acme-email <operator-email> \
  --operator-age-recipient age1... \
  --allow-source <your-workstation-ip> \
  # multi-node: repeat --pre-enroll-peer <ip> for each joining node
```

**Anything unchecked or uncertain?** → **stop.** The cost of waiting is measured
in minutes; the cost of a broken production cutover — leaked/blocklisted mail IP,
undecryptable backups, customer downtime — is measured in days.

---

## Post-bootstrap verification (before announcing go-live)

- [ ] `kubectl get nodes` — all nodes `Ready` (1, or 3 for HA)
- [ ] `kubectl get pods -A | grep -vE 'Running|Completed'` — empty
- [ ] `flux get kustomizations -A` — `hosting-platform-production` `Ready=True`, and its `GitRepository` source is pinned to the release **tag** (not a branch)
- [ ] `sudo insula cluster doctor` — all-OK (version, cosign anchor, host-migrations applied)
- [ ] `curl -fsSLk https://admin.<apex>/api/v1/healthz` → `{"status":"ok"}`
- [ ] `./scripts/smoke-test.sh` (API compatibility) passes; `make smoke` (cluster networking) passes
- [ ] Admin panel loads at `https://admin.<apex>/`; log in with seeded credentials; **valid LE-prod TLS** (not the staging CA)
- [ ] Send + receive a real test email through the mail server; confirm SPF/DKIM/DMARC pass at an external checker
- [ ] One throwaway tenant E2E: create → deploy a site (real TLS) → mailbox → DB → snapshot → suspend → resume → **delete**
- [ ] Then delete `/etc/insula/admin-credentials` and create real named admins

## After cutover

- [ ] For each migrated site: DNS re-point per [`PLESK_MIGRATION.md`](./PLESK_MIGRATION.md) — treat a `partial` migration as **failed**, retry after fixing the cause
- [ ] Monitor mail reputation for the first days of sending (postmaster tools, blocklist checks)
- [ ] Note every deviation from this checklist in the session summary / runbook
- [ ] Schedule the first real backup and verify it lands in the chosen target
