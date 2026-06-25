# Platform-Apex Rename — Operator Runbook

> Rename the platform's brand apex (`platform_domain`) as a single turnkey
> action. The admin/tenant/webmail/mail hostnames, their TLS certs, the Stalwart
> web-admin UI, and the private-worker tunnel anchor all follow the new apex; the
> **tenant CNAME target (`ingress_base_domain`) is left untouched**. R16.
>
> Roadmap context:
> [ROADMAP.md → R16](../roadmap/ROADMAP.md#r16--decouple-ingress_domain-from-platform_domain--turnkey-apex-rename).

## Two domains, decoupled

The single `ingress_base_domain` setting used to mean *both* "the platform brand
apex" *and* "the CNAME target tenant subdomains point at". R16 split them:

| Setting | Means | Moves on rename? |
|---------|-------|------------------|
| `platform_domain` (apex/brand) | `admin.<apex>`, `tenant.<apex>`, `webmail.<apex>`, `mail.<apex>`, `stalwart.<apex>`, `tunnels.<apex>` | **Yes** |
| `ingress_base_domain` (CNAME target) | `<slug>.ingress.<ingress_base_domain>` for tenant sites | **No** |

`getPlatformApex()` resolves `platform_domain`, falling back to
`ingress_base_domain` when unset (so upgrades are zero-change; migration `0066`
seeds them equal). After a rename the cluster legitimately serves **two**
domains: the old one still carries tenant traffic, the new one carries the
platform surfaces.

## What a rename does

`POST /api/v1/admin/platform-domain/rename` (`super_admin`) with
`{ "newApex": "brand.example.test" }`:

1. Rewrites the canonical settings (DB is authoritative):
   `platform_domain`, `admin_panel_url`, `tenant_panel_url`,
   `default_webmail_url`, `mail_server_hostname`.
2. Runs the reconcilers in sequence (best-effort; DB wins if one errors):
   - **panels** — `platform-ingress` IngressRoute `Host()` rules + the
     `platform-ingress` Certificate `dnsNames` for `admin.`/`tenant.`
   - **webmail** — the webmail IngressRoute Host + the `stalwart-jmap-cors`
     CORS origin
   - **mail** — pushes `mail.<apex>` into Stalwart's `defaultHostname` (SMTP
     banner / EHLO / cert SAN) via JMAP and kicks Stalwart's ACME
   - **stalwartWebadmin** — the `stalwart-webadmin` IngressRoute + Certificate
     (seed-then-disown: `reconcile: disabled`, platform-api owns the Host/cert)
   - **tunnelAnchor** — the `tunnels.<apex>` anchor IngressRoute + Certificate
3. Writes an audit row and returns a `dnsRequired` list — exactly which
   hostnames you must make resolvable.

The response's `reconciled` map shows `reconciled` / `no-change` / `error: …`
per surface. An `error:` on `panels` means the in-process reconcile half-applied
— see Troubleshooting.

## Pre-flight (do this BEFORE you click rename)

The rename **moves the admin host**. The moment it commits, `admin.<old-apex>`
stops routing to the panel and you continue at `admin.<new-apex>`. So:

1. **Create DNS first.** For each host in the (anticipated) `dnsRequired` set —
   `admin`, `tenant`, `webmail`, `mail`, `stalwart`, and `tunnels` (only if you
   use private-worker tunnels) — create `A`/`AAAA` (or a `CNAME` to the ingress)
   **before** renaming. DNS automation (PowerDNS, §3e) does **not** yet create
   these for you — this is a manual step.
2. **Have the new admin URL ready.** You'll re-authenticate at
   `https://admin.<new-apex>` immediately after.
3. Confirm the tenant CNAME target won't change (it won't) so tenant sites keep
   resolving on the old domain.

## Run it

### Admin UI

**Admin → Cluster → Networking → Platform Domain (apex / brand).** Enter the new
apex, click **Rename**, confirm the dialog (it restates: moves admin/tenant/
webmail/mail + certs; leaves `ingress_base_domain`; admin reachable only at the
new host once DNS works). The result panel shows the reconciliation map.

### CLI (works even when the panel is unreachable)

`platform-ops domain rename --to <apex>` runs the **same** orchestration as the
API, executed **in-pod** (`kubectl exec deploy/platform-api -c api -- node
dist/cli/platform-domain-rename.js --to <apex>`). It runs in-pod because the
rename graph pulls in native modules (bcrypt via `oidc/service`) that the SEA
binary can't load on a bare host. Add `--json` for machine output.

> The CLI is the reliable path during a rename **back** (revert) or when you've
> renamed to an apex whose admin DNS isn't live yet — you don't need the panel.

## After the rename — verify

1. **Re-authenticate at the new admin host:** `https://admin.<new-apex>`.
2. **IngressRoute hosts flipped:**
   ```bash
   kubectl -n platform get ingressroute platform-ingress \
     -o jsonpath='{.spec.routes[*].match}'      # → Host(`admin.<new-apex>`) …
   kubectl -n mail get ingressroute stalwart-webadmin \
     -o jsonpath='{.spec.routes[*].match}'      # → Host(`stalwart.<new-apex>`)
   ```
3. **Certs reissue** (HTTP-01; async — needs DNS live):
   ```bash
   kubectl -n platform get certificate platform-ingress -o wide
   kubectl -n mail get certificate stalwart-webadmin -o wide
   ```
   A trusted cert on `admin.<new-apex>` typically appears within ~1 min of DNS
   resolving.
4. **Mail TLS** is **Stalwart-native ACME**, not cert-manager — there is no
   cert-manager Certificate for `mail.<apex>`. Ensure `mail.<new-apex>` resolves;
   Stalwart renews on its reconciler tick.
5. **Tenant CNAME target unchanged:**
   ```bash
   # ingress_base_domain in system_settings must equal its pre-rename value
   ```

## Troubleshooting

- **Panel won't load after rename.** Expected if `admin.<new-apex>` DNS/cert
  isn't live yet. Use the CLI to check/finish, or to revert
  (`platform-ops domain rename --to <old-apex>`). Don't panic — the DB holds the
  new apex; the surfaces re-converge from it.
- **`panels` reconcile returned `error:` (half-applied).** A first-generation
  in-process attempt could flip the IngressRoute but throw on a cert/oauth
  sub-step. Recovery: **delete the platform-api pod** (don't `rollout restart` on
  a Flux cluster) — the startup reconcilers re-converge every platform host from
  the DB. The in-pod CLI path avoids this failure mode.
- **New hostnames don't resolve.** DNS automation is residual (§3e); you must
  create the records. Re-read the rename response's `dnsRequired` for the exact
  list.
- **Certs stuck pending.** cert-manager can't complete HTTP-01 until DNS
  resolves. Verify DNS, then watch:
  ```bash
  kubectl -n cert-manager logs -l app.kubernetes.io/instance=cert-manager -f
  ```

## What still does NOT follow a rename

- **Live per-worker tunnel subdomains** (`<slug>.tunnels.<apex>`). The anchor
  (`tunnels.<apex>`) follows; existing workers keep their env-driven URL + per-FQDN
  cert until the (disruptive) tunnel re-issue lands. New workers use the new apex.
- **DNS records** — §3e automation isn't built; records are manual (above).

## The Stalwart webmail master is intentionally NOT renamed

The Stalwart master principal (`master@local.host`, used for IMAP/JMAP
master-auth impersonation by Roundcube/Bulwark + tenant-mailbox backups) lives
on a **fixed sentinel Domain** that is deliberately decoupled from the mail
domain (2026-06-25). A rename does **not** — and must not — touch it: the master
is auth infra only, never used for mail routing or DNS/MX, so anchoring it to
`mail.<apex>` was the wrong coupling (a rename left `master@mail.<oldApex>`
dangling and never re-stamped `STALWART_MASTER_USER` → the staging mail-backup
`AUTHENTICATIONFAILED` bug). The sentinel is reserved platform-side so no tenant
can collide. No action on rename.

> **One-time migration for installs provisioned before 2026-06-25** (whose
> Secret still reads `master@mail.<apex>`): run the in-pod CLI once —
> `kubectl -n platform exec deploy/platform-api -- node dist/cli/mail-rotate-master.js`
> (or `platform-ops mail rotate-master`). It creates `master@local.host` with the
> Admin role, re-stamps `STALWART_MASTER_USER` + `STALWART_MASTER_PASSWORD`, and
> rolls Roundcube. The API/UI rotate button refuses the legacy value with
> `WEBMAIL_MASTER_DOMAIN_MISMATCH` until this CLI migration runs.

## Reference

```
POST /api/v1/admin/platform-domain/rename     # { newApex }  (super_admin)
GET  /api/v1/admin/platform-domain            # current apex + derived hostnames
CLI: platform-ops domain rename --to <apex>   # same orchestration, in-pod
```

| Surface | Setting rewritten | Reconciler |
|---------|-------------------|------------|
| Admin / tenant panels | `admin_panel_url`, `tenant_panel_url` | `reconcileIngressHosts` |
| Webmail | `default_webmail_url` | `reconcileWebmailIngress` + CORS |
| Mail host | `mail_server_hostname` | Stalwart domain reconciler (JMAP + ACME) |
| Stalwart web-admin | `stalwart_admin_url` (apex default) | `reconcileStalwartWebadminIngress` |
| Tunnel anchor | derived from apex | `reconcileTunnelAnchorIngress` |
| **Tenant CNAME target** | `ingress_base_domain` | **untouched** |

## Where things live

- Backend: `backend/src/modules/platform-domain/` (`routes.ts`, `service.ts`);
  resolver `backend/src/modules/system-settings/platform-domain.ts`; reconcilers
  in `system-settings/`, `webmail-router/`, `mail-admin/`, `private-workers/`
  (+ shared `traefik-host-reconcile.ts`).
- CLI: `backend/src/cli/platform-ops/domain.ts` (host wrapper),
  `backend/src/cli/platform-domain-rename.ts` (in-pod entrypoint).
- Admin UI: `frontend/admin-panel/src/pages/cluster/NetworkingPage.tsx`.
- Migration `0066` (adds + seeds `platform_domain`).
