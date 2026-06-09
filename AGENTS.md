# AGENTS.md — Insula Kubernetes Web Hosting Platform

> **Canonical agent instructions.** This is the single source of truth for any AI coding
> agent working in this repo (Claude Code, Codex, Cursor, Copilot, …). `CLAUDE.md` is a
> symlink to this file. It holds **durable rules + architecture only** — point-in-time work
> logs and changelog-style history live elsewhere (`CHANGELOG.md`, `docs/history/`, git log).

## Project Overview

Kubernetes-based web hosting platform replacing Plesk. Targets 50–100 tenants initially on
self-managed k3s clusters (cloud VPS, lean monthly budget).

**Status:** Core feature-complete; production cutover pending. Open follow-ups: `docs/roadmap/ROADMAP.md`.
**Open source:** ships publicly under AGPL — design every decision through an OSS lens (see *No vendor lock-in*).

---

## Golden Rules (read first)

The six that prevent the most damage. Each is expanded below.

1. **Isolate code work in a dedicated git worktree** (`.claude/worktrees/<topic>`), never the live
   working tree. Other agents edit the repo and clusters in parallel — never `git add -A`.
2. **Prove it with a real end-to-end run** against a running system before claiming done.
   Unit tests hide cluster bugs.
3. **The repo is PUBLIC.** Never commit live hostnames, mailbox addresses, IPs, or secrets —
   redact to `example.test` / `<apex>`. Force-push and branch deletion are ruleset-blocked, so a
   leaked commit needs the operator to clean up.
4. **Don't change mail cert strategy or mail port-exposure without asking** — the HAProxy
   DaemonSet is the intended HA path.
5. **Forward-fix, never revert code to dodge a cluster-apply error.** Rebase before any `main` push;
   never `--force` on a non-fast-forward.
6. **New components default to the latest stable upstream release** — an older pin needs an
   explicit reason in the commit message *and* an inline comment.

---

## Working Agreements

The hard-won rules. Violating these is how past sessions broke things.

### Worktrees & parallel agents
- All code work happens in a dedicated worktree (`.claude/worktrees/<topic>` or an isolated
  worktree per agent). Use canonical branch names; clean up when the task merges.
- Fresh worktrees have an **empty `node_modules`** — symlink it from the main checkout before
  `typecheck` / `test` / `build`, or tooling fails confusingly.
- Multiple agents mutate the repo and live clusters concurrently. **Never `git add -A`** — stage
  explicit paths only. Don't assume the working tree is yours alone.

### Verification & E2E discipline
- **Real E2E before "done":** drive the full user flow via `curl` + `kubectl` (and a real browser
  for UI). `./scripts/smoke-test.sh` checks API compatibility after deploy; `make smoke` checks
  cluster networking after infra changes.
- For UI bugs, drive the **exact path the operator drives** — cookie + ingress + NetworkPolicy +
  endpoints. Every admin/tenant-panel button, modal, and iframe must be exercised in a real browser.
- Integration scenarios **end with `curl`/`openssl` against the user-facing endpoint** and assert
  user-visible outcomes. Never claim "integration tested" without the real harness
  (`scripts/integration-*.sh`).
- Treat a tenant-bundle `status: partial` as a **FAILED** test — assert `== "completed"`, never
  silently accept `partial`.
- Run TypeScript + security + a quick `grep` review **before** pushing. The deploy loop is too slow
  to debug in.
- After a deploy, hand back a short **UI verification checklist**.

### Git & PRs
- **Default to commit + push at task end** without being asked.
- **Always `fetch` + `rebase` before pushing `main`.** `main` auto-pins images on every push, so a
  manual push must rebase first. Never `--force` a non-fast-forward.
- Conventional-commit messages (`feat|fix|refactor|docs|test|chore|perf|ci`). Attribution is
  disabled globally — no co-author trailers. For PRs, analyze the **full** commit history
  (`git diff <base>...HEAD`), not just the latest commit.
- **Never chain `cd` with another command** (chained `git` subcommands are fine). A pre-commit hook
  blocks `git commit` when the command line contains any `-n` / `--no-*` token — write the message
  to a file and use `git commit -F <file>` as a separate call.
- **Never revert code** to work around a cluster-apply error — forward-fix.

### Public-repo hygiene & secrets
- This repo is **public open source**. Redact every live identifier (mailbox, hostname, IP, node
  name, admin password) to `example.test` / `<apex>` in commits, PRs, and comments.
- No hardcoded secrets — env vars or the secret manager only. Validate required secrets at startup.

### Build & local-dev gotchas
- `packages/api-contracts` rebuild needs **`tsc --build --force`** — a plain `npm run build` honors
  a stale `tsbuildinfo` and emits **0 files**.
- Admin/tenant panels: edit **`nginx.conf.template`**, not `nginx.conf` — the entrypoint `envsubst`s
  the template and overwrites `default.conf` at startup.
- Local dev goes through **`./scripts/local.sh`**, never raw `docker compose`.
- `npx` is broken in this environment (exits 216) — call `node_modules/.bin/<tool>` directly.
- Inline shell inside **Flux-rendered YAML** must escape `${VAR}` as `$${VAR}` — `postBuild.substituteFrom`
  silently eats unescaped ones.
- Email-domain TLDs are alpha-only (Zod 3.25 strictness) — keep test fixtures valid.
- Every script that writes to `/tmp` must `trap … EXIT` clean up — tmpfs leftovers pin node RAM.

### Cluster / infra invariants & safety
- **Never `kubectl rollout restart` on a Flux-managed cluster.** Flux treats the restart annotation
  as git drift and scales the new ReplicaSet back to 0. Go through git, or delete the pod and let the
  ReplicaSet recreate it from the current template.
- Always provision via **`./scripts/bootstrap.sh`** — never raw `curl get.k3s.io`.
- New cluster peers MUST be pre-enrolled via the **`ClusterPendingPeer` CR** (or admin UI). A manual
  `peer-firewall-add` is reverted by the reconciler in ~5s; bootstrap `--pre-enroll-peer` only
  affects the node being installed.
- If a deployed feature "doesn't work," **first check `kubectl get rs` for `ReplicaFailure`**
  (usually a quota block) before blaming the build or buildkit cache.
- **STOP before any DROP / recreate on a system PVC** — enumerate snapshots and bundles first.
- Every operator-facing failure renders an `OperatorError` via `<ErrorPanel>`.

### UI/UX conventions
- Every UI element needs a `dark:` variant.
- Env-var edit UX must match the resource-edit pattern (spinner, modal close, pending state).

---

## Monorepo Structure

```
packages/
  api-contracts/          # Shared Zod schemas + TypeScript types (SINGLE SOURCE OF TRUTH)
backend/                  # Node.js/Fastify management API (port 3000)
frontend/
  admin-panel/            # React 18 + Vite + shadcn/ui (port 5173)
  tenant-panel/           # React 18 + Vite + shadcn/ui (port 5174)
k8s/
  base/                   # Kustomize base manifests
  overlays/               # dev, production overlays
  components/             # reusable Kustomize components (auth gates, …)
scripts/                  # Utility + bootstrap + integration scripts
docs/                     # architecture/ + operations/ + features/ + development/ (current),
                          # roadmap/ (planned), history/ (frozen)
```

**File organization:** feature/module-based (`backend/src/modules/<feature>/`). Prefer many small,
focused files (200–400 lines typical) over few large ones. Prefer new objects over mutation.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 22 + Fastify 4 + TypeScript 5 |
| ORM | Drizzle ORM (PostgreSQL) |
| Database | PostgreSQL 18 via CNPG (platform DB `platform`; tenant add-on DBs are per-tenant MariaDB/PostgreSQL). Cache is in-memory LRU — Redis removed M14 |
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS + shadcn/ui |
| State | TanStack Query (server), Zustand (client) |
| Testing | Vitest + React Testing Library + Playwright |
| Auth | External Dex OIDC + JWT (Bearer tokens) |
| CI/CD | GitHub Actions + Flux v2 |
| Container Registry | GHCR |
| K8s | k3s + Calico CNI + Traefik v3 (ADR-038) |

## Build & Dev Commands

```bash
# Backend (backend/)
npm run dev              # dev server, hot-reload
npm run build            # tsc compile
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # Vitest (all)
npm run test:unit        # unit only
npm run test:integration # integration (requires DB)
npm run db:migrate       # run migrations
npm run db:generate      # generate migration from schema changes

# Frontend (frontend/admin-panel  |  frontend/tenant-panel)
npm run dev | build | lint | typecheck | test

# Local stack (Unraid/DinD)
./scripts/local.sh ...   # ALWAYS go through local.sh, not raw docker compose

# Post-deploy verification
./scripts/smoke-test.sh  # API compatibility (run after every deploy)
make smoke               # cluster-network smoke (run after any infra/k3s/Calico/netpol change)
```

---

## Architecture & Conventions

### API conventions
- **Prefix:** `/api/v1/`
- **Response envelope:** `{ data, pagination, error }` (see `docs/architecture/API_ERROR_HANDLING.md`)
- **Pagination:** cursor-based, `limit` max 100 (enforced by `MAX_PAGE_LIMIT` in api-contracts)
- **Error codes:** `SCREAMING_SNAKE_CASE`
- **Auth:** JWT Bearer with claims `sub, role (admin|billing|support|read-only), exp, iat`
- Response field names are **camelCase** (Drizzle convention).

### Shared API contracts (CRITICAL)
All API input/output types are defined in **`@insula/api-contracts`** — the single source of truth.
```
packages/api-contracts/src/  → shared.ts (envelopes, PaginationParams), auth.ts, tenants.ts,
                               domains.ts, databases.ts, workload-repos.ts, container-images.ts,
                               sftp-users.ts, index.ts (re-exports)
```
1. ALL API types MUST live in `@insula/api-contracts`. Backend validates with these Zod schemas;
   frontends use `z.infer<typeof schema>`.
2. **Never** define API types locally in backend `schema.ts` or frontend `types/api.ts` — those are
   thin re-exports only.
3. Rebuild with `tsc --build --force` after editing schemas (stale tsbuildinfo → 0 files).
4. Frontends import `MAX_PAGE_LIMIT`; `apiFetch` sets `Content-Type: application/json` only when a
   body exists.
> *Why:* parallel agents kept producing incompatible types — shared contracts make those compile errors.

### Ingress routing — CNAME chain
Per-hostname routing resolves through a CNAME chain so node migrations need **zero client DNS
changes**:
```
blog.example.test → <slug>.ingress.<apex> → <node>.<apex> → <IP>
(client domain)     (platform routing)       (platform infra)
```
- Subdomains → `CNAME` to `<slug>.ingress.<apex>`; apex domains → `A`/`AAAA` to the ingress IP
  (CNAME is illegal at the apex).
- **`ingress_routes` is the single source of truth** for all Ingress rules — the reconciler builds
  K8s Ingress from it, not from `domains.workloadId`.
- Platform settings: `ingress_base_domain`, `ingress_default_ipv4/ipv6`.

### Deployment & GitOps
- **Single k3s cluster** on cloud VPS (no hybrid/home-server split). Scale by adding worker nodes.
- **Longhorn from day one** (replica=1 on single node) for a consistent StorageClass.
- **Runtime config injection:** frontends `envsubst` at container startup (not build-time `VITE_`
  vars) — build once, deploy anywhere.
- **GitOps:** `main` builds + auto-pins images on every push; the `development` branch drives the
  development cluster via Flux; production uses an **admin-controlled pull model** — signed CalVer
  releases verified on-node (openssl against `/etc/platform/cosign.pub`) by `platform-ops`. Specifics
  in `docs/development/` and `docs/architecture/`.
- **Domain placeholders:** every overlay uses `${DOMAIN}`, resolved at apply time by Flux
  `postBuild.substituteFrom` (`ConfigMap/platform-cluster-config`) or `bootstrap.sh`. Never bake a
  literal apex into manifests — a CI guard (`ci-no-pinned-domains.sh`) rejects it.

### External dependencies (ADR-022 / ADR-025 / ADR-026)
These are **separate projects** — this platform only consumes their APIs, with configurable
endpoints in the admin panel. Do not add their deployment concerns here.
- **DNS:** PowerDNS REST API · **VPN mesh:** NetBird · **IAM/Auth:** Dex OIDC
- **Catalog:** one unified catalog of mixed entry types (runtimes/databases/services AND
  self-contained app stacks like WordPress/Nextcloud) fed by one or more catalog repositories. A
  default **Official Catalog** (`github.com/insulahq/application-catalog`) is seeded active and
  removable; admins manage repos under **Applications → Repositories**. Custom containers (ADR-036,
  bring-your-own image) are a separate, non-catalog path.

### DNS provider groups
Domains bind to a provider **group**; a group holds servers with `role` (`primary`/`secondary`) and
`ns_hostnames`. Record CRUD syncs to the group's primary; zone creation goes to all members. Self-
hosted (PowerDNS/BIND) and cloud (Cloudflare/Route53) both fit the abstraction (ADR-022).

### Admin-UI auth gate (platform_session)
Login/refresh also sets an HttpOnly **`platform_session`** cookie (`Domain=.<apex>`, SameSite=Lax,
Secure) used solely to gate subdomain-hosted admin UIs via nginx `auth_request`.
- Mutating endpoints use `authenticate` (**Bearer-only, no cookie fallback** — CSRF-safe; don't add
  one). Only idempotent read gates use `authenticateSession`.
- Every Ingress exposing an admin-only UI MUST be labelled `insula.host/admin-ui: "true"` **and**
  include exactly one auth-gate Kustomize component:
  `k8s/components/admin-auth-gate-cookie` (platform_session) or `…-oauth2` (oauth2-proxy + Dex). CI
  guard `ci-admin-auth-check.sh` fails the build on an admin-ui Ingress with no gate.

### No vendor lock-in
Configurable, never hardcoded. NetBird is **one** mesh-VPN option (the `--cluster-network-cidr`
pattern works for any underlay); no NetBird/Hetzner-specific code paths in services or manifests
beyond opt-in convenience flags. Keep DNS behind the provider-group abstraction so swapping providers
is config-only. The platform targets Kubernetes (k3s/vanilla) — that's the substrate, not lock-in.

---

## Feature Subsystems (operational invariants)

**Tenant lifecycle hook registry (ADR-033).** Every state transition (`active`/`suspended`/
`archived`/`restored`/`deleted`) dispatches a topo-sorted set of `LifecycleHook`s, persists each run
to `tenant_lifecycle_hook_runs`, and a 2-min scheduler retries failed `retry`-status hooks with
backoff. *Add a hook:* create `backend/src/modules/tenant-lifecycle/hooks/<name>.ts` + a
`register*Hook()` with a module-local `_registered` guard, wire it into
`hooks/index.ts:registerAllLifecycleHooks()`. *Add a transition kind:* edit `Transition` in
`registry/types.ts`, extend the migration enum, add an `applyXxx()` in `cascades.ts`. Kill-switch for
fallback-less hooks: `LIFECYCLE_HOOK_<NAME>=disable` (outages only).

**SYSTEM tenant + reserved hostnames (ADR-040).** A single `tenants.is_system=TRUE` row (partial
unique index enforces "at most one") is self-healed on every bootstrap/startup by
`system-tenant/bootstrap.ts`. It owns the apex domain row and `_system@<apex>` mailbox admin, and
**cannot be suspended/archived/deleted** (service guards + a `order:1, blocking:abort` hook + SQL
filters). Reserved platform subdomains are refused at domain/DNS-record creation with HTTP 409
`RESERVED_PLATFORM_HOSTNAME` (5s TTL cache; CI guard `ci-system-tenant-check.sh`).

**Admin node-terminal (ADR-041).** `super_admin`-only one-shot privileged Pod →
`nsenter`-into-PID-1 host shell on a target node. 30-min step-up freshness gate (OIDC-only users get
`STEP_UP_UNAVAILABLE 409`); 256-bit single-use 60s `wsToken`. Feature flag `node-terminal-enabled`
(dev/staging ON, production OFF). CI guard `ci-node-terminal-check.sh` (12 invariants). Runbook:
`docs/operations/NODE_TERMINAL.md`.

**Security / firewall / node hardening** — `/settings/security-hardening` (super_admin),
read-mostly. Driven by the `security-probe` DaemonSet (read-only host mounts, drops ALL caps). SSH
lockdown via `bootstrap.sh --ssh-via-mesh <iface>` (opt-in). Runbook:
`docs/operations/SECURITY_HARDENING.md`. CI guards `ci-firewall-check.sh`, `test-ssh-via-mesh.sh`.

**Secrets lifecycle.** `bootstrap.sh` writes an age-encrypted Tier-1 bundle to
`/var/lib/hosting-platform/bundles/`. `make secrets-fetch HOST=…`, `make secrets-restore BUNDLE=… KEY=…`.
Emergency admin reset: `scripts/admin-password-reset.sh --email <addr> --random`. Full model:
`docs/operations/SECRETS_LIFECYCLE.md`.

**HA mode.** Postgres is CNPG-managed from first install (default `instances: 1`). Apply-HA scales
CNPG 1↔3 + Longhorn 1↔3 replicas + stateless Deployments 2↔3 with topologySpread — single-button,
reversible. `docs/architecture/HA_MODE.md`.

**Cluster firewall.** Three modes — `cidr` (mesh/VLAN), `set` (HA, reconciled from kube-API by
`firewall-reconciler`), `single`. All control-plane ports are scoped, never `0.0.0.0/0`; dual-stack.
`docs/operations/CLUSTER_NETWORK.md`; CI guard `ci-firewall-check.sh`.

**Mail.** Stalwart-based. Mail TLS via **Traefik → `stalwart-mail-acme` ClusterIP :80 → Stalwart
http-acme** (not HAProxy). Don't change cert strategy or port-exposure mode without asking. Webmail:
Bulwark (JMAP-native) coexists with Roundcube; `platform_config.default_webmail_engine` selects the
default. Feature-visibility flags `webmail_show_{contacts,calendar,files}` are **CSS-only** — DAV
endpoints stay reachable for native clients. Webmail docs: `docs/features/BULWARK_WEBMAIL.md`.

**Supported OSes.** Tier-1: Debian 12/13, Ubuntu 22.04/24.04 LTS. Tier-2: RHEL/Rocky/Alma 9, CentOS
Stream 9/10, Amazon Linux 2023. `bootstrap.sh` dispatches apt vs dnf via `OS_FAMILY`; fails fast on
EOL/unsupported. Matrix harness: `scripts/test-bootstrap-os-matrix.sh`.

---

## Key Documentation
- Architecture: `docs/architecture/PLATFORM_ARCHITECTURE.md`
- Database schema: `docs/architecture/DATABASE_SCHEMA.md`
- API spec: `docs/architecture/MANAGEMENT_API_SPEC.md`
- Error handling / pagination: `docs/architecture/API_ERROR_HANDLING.md`, `…/API_PAGINATION_STRATEGY.md`
- ADRs: `docs/architecture/adr/ARCHITECTURE_DECISION_RECORDS.md`
- Roadmap (open follow-ups): `docs/roadmap/ROADMAP.md`
- Operations runbooks: `docs/operations/` (tenant backup, secrets, cluster network, node terminal, security hardening, …)

> **Where history lives:** this file is durable rules + architecture. Dated, PR-by-PR work history is
> not kept here — see `CHANGELOG.md`, `docs/history/`, and the git log.
