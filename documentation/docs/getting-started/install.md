---
verified: 2026.7.4
---

# Install a single node

One command turns a fresh server into a running Insula platform. This page walks
the single-node install end to end: what `insula bootstrap` does, how to run it,
your first login, and a quick health check.

Before you start, confirm you meet the [requirements](requirements.md): a
supported OS, a domain you control with DNS access, root/SSH on the server, and
the [needed ports](requirements.md#ports) open.

## What `insula bootstrap` does

On the target node, in one run, it:

1. **Hardens the host** — SSH config and a host firewall (the control-plane
   ports are scoped, never world-open).
2. **Installs k3s + Calico**, then the platform layer: **Traefik v3** ingress
   (with CrowdSec + ModSecurity-CRS), **cert-manager**, **Sealed Secrets**, and
   **Flux v2**.
3. **Deploys the platform** — API, admin/tenant panels, PostgreSQL (CNPG), and
   the mail server, reconciled by Flux.
4. **Generates your first admin login** and writes an **age-encrypted Tier-1
   secrets bundle** to `/var/lib/insula/bundles/`.
5. **Runs an advisory smoke test** at the end.

## Run it

Download the signed **`insula`** binary onto the server and run
`insula bootstrap` as root. That's the whole install — no repository clone.

```bash
# Pick your CPU arch: amd64 (x86-64) or arm64.
curl -fsSLO https://github.com/insulahq/insula/releases/latest/download/insula-linux-amd64

# (recommended) VERIFY the signed binary before you run it — fetch the trust
# anchor + signature first, then cosign-verify. Never execute an unverified
# installer. `cosign.pub` is the project's public trust anchor (in the repo).
curl -fsSLO https://github.com/insulahq/insula/releases/latest/download/insula-linux-amd64.sig
curl -fsSLO https://raw.githubusercontent.com/insulahq/insula/main/platform/cosign.pub
cosign verify-blob --key cosign.pub --signature insula-linux-amd64.sig insula-linux-amd64

chmod +x insula-linux-amd64
sudo mv insula-linux-amd64 /usr/local/bin/insula

sudo insula bootstrap --join-as server \
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

!!! tip "The binary is the whole installer"
    `insula` is a single cosign-signed executable. The installer (OS prep, k3s,
    firewall, cert-manager, Flux, the platform manifests) travels *inside* it, so
    there is nothing else to fetch. On first run it seeds the cluster from those
    embedded manifests, then hands ongoing reconciliation to Flux (which pulls
    from GitHub), and installs *itself* to `/usr/local/bin/insula` with a daily
    self-upgrade timer. Two trust-anchor roles, don't conflate them: the
    `cosign.pub` you fetch **above** verifies the binary *before you run it*
    (recommended); separately, bootstrap persists that same anchor to
    `/etc/platform/cosign.pub` on the node so the daily self-upgrade can verify
    future releases — you don't install that one by hand.

??? info "Prefer to run from a checkout? (development)"
    The classic repo path still works and is what contributors use:
    ```bash
    git clone https://github.com/insulahq/insula.git
    cd insula
    sudo ./scripts/bootstrap.sh --join-as server --domain … --acme-email …
    ```
    Only `scripts/` + `k8s/` + `platform/VERSION` are consumed — the rest of the
    repo (backend/frontend/images) ships as prebuilt images and is not needed at
    install time. `./scripts/bootstrap.sh --help` is the authoritative flag list
    for both paths (`insula bootstrap --help-full` prints the same).

### Useful options

| Flag | When to use |
|---|---|
| `--env <dev\|staging\|production>` | Defaults to `production`. |
| `--skip-longhorn` | Use k3s `local-path` storage instead of Longhorn (fine for a single node). |
| `--operator-age-recipient <age1…>` | Supply your own backup-encryption public key. If omitted, a keypair is generated and the **private key is printed once** — save it. |
| `--require-smoke-pass` | Make the post-install smoke test fatal (for automated installs). |
| `--remote <host> --ssh-key <path>` | Run the whole thing against a remote server from your workstation. |

Run `insula bootstrap --help` for the common flags, or `insula bootstrap
--help-full` for the complete, authoritative list.

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

Your seeded admin credentials are written to **`/etc/insula/admin-credentials`**
on the server (and logged once during the run):

```bash
sudo cat /etc/insula/admin-credentials
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
