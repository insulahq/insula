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

You need **`curl`** and **`openssl`** on the server for these steps. `openssl`
ships on every supported OS; `curl` is frequently absent from minimal Debian
images — install both with
[one command](requirements.md#tools-you-need-on-the-server) if they're missing.

```bash
# Pick your CPU arch: amd64 (x86-64) or arm64.
curl -fsSLO https://github.com/insulahq/insula/releases/latest/download/insula-linux-amd64
```

### Verify the download

Never execute an unverified installer. Every release asset is signed with the
project's offline release key; `cosign.pub`, kept in the repository, is the
matching public trust anchor.

```bash
curl -fsSLO https://github.com/insulahq/insula/releases/latest/download/insula-linux-amd64.sig
curl -fsSLO https://raw.githubusercontent.com/insulahq/insula/main/platform/cosign.pub

openssl dgst -sha256 -verify cosign.pub \
  -signature <(base64 -d insula-linux-amd64.sig) insula-linux-amd64
```

It must print exactly:

```
Verified OK
```

Anything else — `Verification failure`, a base64 error, a non-zero exit — means
the binary or the signature is not what we published: **delete the download and
stop.** Do not run it.

Nothing extra to install: a release signature is a base64-encoded
ECDSA-P256-over-SHA-256 signature, so `openssl` checks it directly. This is the
same check each node performs on every self-upgrade, which is why cosign is
never installed on a server.

!!! note "`<(…)` needs bash or zsh"
    In a plain POSIX `sh`, decode to a file first:
    `base64 -d insula-linux-amd64.sig > sig.der`, then pass `-signature sig.der`.

??? question "Prefer `cosign`? Then expect two alarming-looking lines"
    cosign verifies the very same signature, but prints two notices on the way
    to succeeding (output below from cosign v3.1.2):

    ```bash
    cosign verify-blob --key cosign.pub --signature insula-linux-amd64.sig \
      --insecure-ignore-tlog=true insula-linux-amd64
    ```

    ```
    Flag --signature has been deprecated, please use --bundle to provide a signature
    WARNING: Skipping tlog verification is an insecure practice that lacks transparency and auditability verification for the blob.
    Verified OK
    ```

    **Both lines are expected here, and `--insecure-ignore-tlog=true` is
    mandatory** — without it cosign fails outright with `Error: signature not
    found in transparency log`.

    Why: Insula releases are signed with a **long-lived offline key** and are
    deliberately *not* published to Rekor, the public transparency log. There is
    no log entry to look up, so cosign is being asked to skip a check that could
    never pass, and it warns generically about that.

    What you do and don't get:

    - **You still get** full cryptographic proof that these bytes were signed by
      the private key matching `cosign.pub` — identical to the `openssl` check
      above and to what the node enforces on every upgrade. The word "insecure"
      in cosign's message refers to skipping the log, not to the signature.
    - **You don't get** third-party auditability: a public, append-only record
      that this signature existed at a point in time. With an offline key that
      trade-off is deliberate — the key never touches a network-connected signer.

    `--signature` still works; the deprecation points at cosign's newer bundle
    format, which our release assets don't use.

### Install and bootstrap

```bash
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

### If the run stops partway

**Re-run the exact same command.** Bootstrap is idempotent: each component
checks whether it is already installed and skips it, so a second run resumes
roughly where the first stopped rather than starting over.

That is the answer for the most common cause — a third-party outage while a
chart is being pulled. Chart downloads reach GitHub and the upstream chart
repositories, and a bad minute there surfaces as, for example:

```
Error: failed to fetch https://github.com/longhorn/charts/releases/download/longhorn-1.12.0/longhorn-1.12.0.tgz : 500 Internal Server Error
```

Bootstrap now retries these automatically, but a longer outage still stops the
run. Nothing is corrupted — wait a minute and re-run.

Three things that look like errors in the log but are not:

- `warnings.go:107] "Warning: unrecognized format \"int64\""` — kubectl
  commenting on a third-party CRD's OpenAPI schema while it is applied. It comes
  from the upstream chart, affects nothing, and there is no action to take.

- `Host iptables-save/iptables-restore tools not found` — k3s reporting that it
  will use its own bundled iptables. Harmless **for k3s**, which genuinely does
  not need the host package.

    !!! warning "It is not harmless for everything else"
        Other software on the node probes for an `iptables` binary and changes
        behaviour when it is missing. NetBird, for one, falls back to writing
        native nftables rules into the `filter` table — which Calico manages
        through `iptables-nft` — and Calico's Felix then fails every dataplane
        resync with *"iptables-save failed because there are incompatible nft
        rules in the table"*. `calico-node` stays `0/1 Ready` and NetworkPolicy
        stops being programmed.

        Installers from **v2026.8.2** onward add the `iptables` package for
        exactly this reason, and a host-migration installs it on existing nodes.
        If you see `calico-node` stuck at `0/1`, check `command -v iptables`
        first.
- `Resources populated with this chart don't match with labelSelector
  acme.cert-manager.io/http01-solver=true` — the Traefik chart noting that its
  own resources don't carry that label. Deliberate: Traefik is configured to
  pick up **only** cert-manager's HTTP-01 solver Ingresses, because all other
  platform routing goes through IngressRoute CRDs.

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
