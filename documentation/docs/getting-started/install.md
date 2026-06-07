---
verified: 2026.6.7
---

# Install a single node

One command turns a fresh server into a running Insula platform. This page walks
the single-node install end to end: what the script does, how to run it, your
first login, and a quick health check.

Before you start, confirm you meet the [requirements](requirements.md): a
supported OS, a domain you control with DNS access, root/SSH on the server, and
the [needed ports](requirements.md#ports) open.

## What `bootstrap.sh` does

On the target node, in one run, it:

1. **Hardens the host** — SSH config and a host firewall (the control-plane
   ports are scoped, never world-open).
2. **Installs k3s + Calico**, then the platform layer: **Traefik v3** ingress
   (with CrowdSec + ModSecurity-CRS), **cert-manager**, **Sealed Secrets**, and
   **Flux v2**.
3. **Deploys the platform** — API, admin/tenant panels, PostgreSQL (CNPG), and
   the mail server, reconciled by Flux.
4. **Generates your first admin login** and writes an **age-encrypted Tier-1
   secrets bundle** to `/var/lib/hosting-platform/bundles/`.
5. **Runs an advisory smoke test** at the end.

## Run it

Clone the repository onto the server (the installer needs its sibling
`scripts/lib/` directory — a piped `curl | bash` one-liner is not supported),
then run `bootstrap.sh` as root.

```bash
git clone https://github.com/insulahq/insula.git
cd insula

sudo ./scripts/bootstrap.sh --join-as server \
  --domain hosting.example.com \
  --acme-email ops@example.com \
  --allow-source 198.51.100.7
```

| Flag | Meaning |
|---|---|
| `--join-as server` | This node is the control plane. (The first node is always a `server`.) |
| `--domain <FQDN>` | Your platform base domain. Required on the first server. |
| `--acme-email <email>` | Email for Let's Encrypt. Required on the first server. |
| `--allow-source <ip\|cidr>` | Trust this source (e.g. your workstation IP) so `kubectl` and SSH work before the admin panel exists. Repeatable. |

The OS detection and package install (apt vs dnf) are automatic — the same
command works on Debian/Ubuntu and on RHEL-family / Amazon Linux 2023.

### Useful options

| Flag | When to use |
|---|---|
| `--env <dev\|staging\|production>` | Defaults to `production`. |
| `--with-monitoring` | Also install Prometheus + Loki + Grafana. |
| `--skip-longhorn` | Use k3s `local-path` storage instead of Longhorn (fine for a single node). |
| `--operator-age-recipient <age1…>` | Supply your own backup-encryption public key. If omitted, a keypair is generated and the **private key is printed once** — save it. |
| `--require-smoke-pass` | Make the post-install smoke test fatal (for automated installs). |
| `--remote <host> --ssh-key <path>` | Run the whole thing against a remote server from your workstation. |

Run `./scripts/bootstrap.sh --help` for the complete, authoritative flag list.

!!! warning "Save the backup-encryption key"
    If you don't pass `--operator-age-recipient`, bootstrap generates an age
    keypair and prints the **private key to stderr exactly once**. It is the
    only way to decrypt your backups later — store it offline immediately
    (password manager + paper). Losing it means losing disaster recovery.

## First login

When bootstrap finishes it prints a summary like:

```
  BOOTSTRAP COMPLETE
  Server IP:    203.0.113.10
  Domain:       hosting.example.com
  Endpoints:
    Admin:   https://admin.hosting.example.com
    Tenant:  https://tenant.hosting.example.com
    API:     https://api.hosting.example.com
```

Your seeded admin credentials are written to **`/etc/platform/admin-credentials`**
on the server (and logged once during the run):

```bash
sudo cat /etc/platform/admin-credentials
# ADMIN_EMAIL=admin@hosting.example.com
# ADMIN_PASSWORD=<generated>
```

1. Make sure `admin.<domain>` resolves to the server's IP.
2. Open **`https://admin.<domain>`** and log in with those credentials.
3. Change the password and create a real admin user, then remove the seed file.

!!! tip "Certificates may take a minute"
    On a cold first boot, Let's Encrypt issuance and the last Flux reconciles can
    lag by a minute or two. If the panel shows a TLS warning at first, wait and
    refresh.

## Post-install health check

From the admin panel, confirm the dashboard loads and the node shows **Ready**.
From the server (or your workstation with the kubeconfig), you can also check
directly:

```bash
# On the server:
sudo kubectl get nodes
sudo kubectl get pods -A

# From your workstation:
scp root@<server-ip>:/etc/rancher/k3s/k3s.yaml ./kubeconfig.yaml
sed -i 's/127.0.0.1/<server-ip>/g' kubeconfig.yaml
export KUBECONFIG=./kubeconfig.yaml
kubectl get nodes
```

The bootstrap run also executes a cluster-network smoke suite at the end
(advisory by default). If it reports failures on a fresh install, they're often
transient — re-run `scripts/smoke-test-cluster-network.sh` after a few minutes.

## Next steps

- [Add more nodes and turn on high availability](multi-node.md)
- [Create your first tenant and deploy a site](first-tenant.md)

??? info "Under the hood"
    - The first server is bootstrapped with `--join-as server` and **no**
      `--server`/`--token`; those are only used when *joining* additional nodes.
    - Bootstrap refuses to re-run with a different `--domain`/`--env` than the
      live cluster unless you pass `--force-domain-change`, to prevent clobbering
      every Ingress and certificate pinned to the old value.
    - Authoritative sources: the `usage()` text and `main()` flow in
      [scripts/bootstrap.sh](https://github.com/insulahq/insula/blob/main/scripts/bootstrap.sh),
      [FORK-AND-DEPLOY.md](https://github.com/insulahq/insula/blob/main/docs/development/FORK-AND-DEPLOY.md),
      [SECRETS_LIFECYCLE.md](https://github.com/insulahq/insula/blob/main/docs/operations/SECRETS_LIFECYCLE.md).
