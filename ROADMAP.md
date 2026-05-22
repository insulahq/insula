# Roadmap

## Implemented (Phase 1)

### OIDC / SSO Authentication
- [x] Multi-provider OIDC support (admin-scoped and tenant-scoped providers)
- [x] Authorization Code flow with PKCE
- [x] Backchannel logout support
- [x] Provider management UI in admin panel
- [x] Global "Disable Local Auth" toggles (separate for admin/tenant panels)
- [x] Break-glass emergency login for locked-out admins
- [x] Dex OIDC provider in staging for testing

### RBAC & Panel Enforcement
- [x] 7-role hierarchy: super_admin, admin, billing, support, read_only, tenant_admin, tenant_user
- [x] JWT panel/tenantId claims with middleware enforcement
- [x] Admin impersonation of tenant accounts
- [x] Auto-create tenant_admin user on tenant creation
- [x] Tenant sub-user management with plan-based limits

### Platform Features
- [x] Full API endpoint coverage: DNS, hosting settings, protected directories
- [x] Workload CRUD with start/stop/deploy
- [x] Cron job start/stop/run-now
- [x] Tenant suspension cascade (domains, workloads, cron jobs)
- [x] SSH keys and resource quotas modules
- [x] Subscription management with plan selection

---

## Planned (Phase 2+)

### Tenant Self-Service Onboarding

**Goal**: Allow tenants to register at an external IAM (Dex/Keycloak), then login to the tenant panel and set up their own hosting account — no admin intervention needed.

**How it works:**

1. Admin configures a tenant-scoped OIDC provider pointing to the external IAM
2. New tenant registers at the IAM (self-service registration)
3. Tenant visits the tenant panel login → clicks "Sign in with SSO"
4. OIDC callback → user authenticated but no tenant account exists yet
5. Platform creates a `pending` user with `tenantId: null`
6. User is redirected to `/onboarding` page:
   - Company name, email (pre-filled from OIDC)
   - Plan selection (Starter, Business, Premium)
   - Region selection
   - Accept terms of service
7. On submit:
   - Backend creates a new `tenant` record
   - Links user to tenant (`tenantId`, `roleName: 'tenant_admin'`)
   - Provisions Kubernetes namespace
   - Optionally: payment gate before provisioning (Stripe/Chargebee)
8. User lands on their dashboard — fully onboarded

**Data model (already prepared):**
- `users` table supports `tenantId: null` (pending users with no tenant)
- `users.status: 'pending'` state exists for pre-onboarding users
- Provider `panel_scope: 'tenant'` determines that new users enter the tenant flow

**Implementation phases:**
1. **Onboarding page** — form with plan/region selection, creates tenant + links user
2. **Email verification** — optional, if IAM doesn't verify emails
3. **Admin approval workflow** — optional gate before account activation
4. **Payment integration** — Stripe/Chargebee checkout before provisioning
5. **OIDC claim mapping** — allow providers to pass role/tenant_id via custom claims for enterprise setups

### Other Phase 2+ Features
- OIDC claim mapping for enterprise IdP integration
- Custom OIDC provider management (Keycloak, Auth0, Okta, Azure AD)
- PostgreSQL 16 as secondary database
- Longhorn storage (replacing k3s local-path)
- Harbor container registry (replacing GHCR)
- Distributed tracing (Tempo)
- Docker-Mailserver + Roundcube email
- FileBrowser file manager integration
- Plesk migration service
- Geographic sharding / multi-region

### IPv6 / dual-stack networking
- [ ] **v1 ships IPv4-only** — `--cluster-cidr` and `--node-ip` are IPv4 only;
      most cloud providers and OSS adopters will be on IPv4-friendly networks.
      Adding dual-stack later is non-breaking (additive flag, additive ipPools).
- [ ] **v2: `--ipv6` opt-in flag** — enables dual-stack:
  - k3s gets `--cluster-cidr=10.42.0.0/16,fd42::/48`,
    `--service-cidr=10.43.0.0/16,fd43::/112`, `--node-ip=<v4>,<v6>`
  - Tigera Installation gets a sibling IPv6 ipPool +
    `nodeAddressAutodetectionV6: { canReach: "2606:4700:4700::1111" }`
  - nftables config opens IPv6 equivalents of every cluster-internal port
  - NetworkPolicy `ipBlock` entries get v6 siblings (the `10.42.0.0/16`
    ipBlock for cross-node host→pod becomes `10.42.0.0/16` + `fd42::/48`)
  - Backend audit: every `request.ip` / IP-parsing call must handle
    IPv6-mapped IPv4 (`::ffff:1.2.3.4`) and pure v6
  - Smoke + failover suite: A and AAAA per hostname, v6 pod-IP cells
- [ ] **v3 (deferred): IPv6-only mode** — for cheaper IPv6-only cloud VMs.
      Niche; out of scope until a deployment actually needs it.

Estimated implementation effort for dual-stack v2: 8-10 hours of focused work.
The platform's data model + most code already tolerates v6 strings (audit_logs
accepts varchar(45) which is RFC v6 max); the work is mostly bootstrap
templating + NetworkPolicy duplication + a backend code audit.

---

## OSS readiness — making the platform fork-friendly

**Goal**: external developers can clone the repo, run any part of the platform
independently, and PR improvements back. Today the repo is functional but
contains friction points for first-time contributors: hard-coded
`insulahq` image refs in two overlay files, no top-level CONTRIBUTING
guide, CI workflows that may push to upstream from fork-PR runs, per-component
dev paths that aren't documented.

The plan is three focused PRs landing after the Traefik migration merges.
Each ships independently; together they make "fork + run locally + PR back"
a 30-min on-ramp instead of a multi-hour archaeology dig.

### PR 1 — Image-org auto-resolution + CI fork-safety

**Image refs**: keep `insulahq` as the upstream canonical so unmodified
clones pull public images out of the box, then add a thin auto-detection
layer for forks.

- [ ] `scripts/preflight-image-org.sh` — idempotent. Resolves
      `IMAGE_REGISTRY_OWNER` from a precedence chain:
      `GITHUB_REPOSITORY_OWNER` (CI) > explicit env > `git remote get-url
      origin` parse > `insulahq` fallback. If the resolved org differs
      from what's in the three overlay `kustomization.yaml` files, rewrites
      in place. Auto-invoked at the top of `local.sh up` and `bootstrap.sh`.
- [ ] **Why a script, not Flux postBuild**: kustomize processes the
      `images:` block BEFORE Flux's envsubst runs, so `${VAR}` in
      `images.newName` doesn't substitute. Script is the only working path
      for Flux-managed clusters.
- [ ] **CI fork-safety**: audit `.github/workflows/*.yml` for hardcoded
      `insulahq` strings (build-deploy.yml already uses
      `${{ github.repository_owner }}` — confirm). Add
      `if: github.repository == 'insulahq/hosting-platform'` guards to
      sync-staging.yml and any workflow that pushes to upstream
      infrastructure.
- [ ] **PR-from-fork CI must run tests + lints WITHOUT push secrets**.
      GitHub Actions doesn't share `secrets.*` with fork PRs by default; the
      build steps need to either skip image push when the SHA isn't on the
      upstream repo, or use `workflow_run` for the push side. Tests stay in
      the pull_request trigger.
- [ ] **GHCR package visibility**: confirm
      `ghcr.io/insulahq/hosting-platform/*` packages are set to
      `public` in package settings. Required for "unmodified clone just
      works".

Effort: ~4 hours.

### PR 2 — Contributor docs

- [ ] **Top-level `README.md` rewrite**: 5-line elevator pitch, screenshot,
      "run locally in 5 minutes" block (literally `git clone &&
      ./scripts/local.sh up`), "deploy to my own VPS in 30 minutes" link,
      contribution invitation.
- [ ] **`CONTRIBUTING.md`** at root: dev setup expectations, code style,
      how to run tests (`backend/`, `frontend/*/`, `packages/api-contracts/`
      each have their own commands), branch + PR conventions, where to find
      ADRs.
- [ ] **`docs/04-deployment/FORK-AND-DEPLOY.md`** (new): explicit "fork →
      deploy to my own cluster" runbook. Covers the image-org preflight,
      GHCR package permissions on the fork, DNS A-records, `bootstrap.sh
      --domain my.example.com --acme-email me@example.com`. Acceptance
      criteria: a competent k8s-aware contributor with a fresh VPS gets
      to a working admin panel in <30 min.
- [ ] **`SECURITY.md`** at root: vulnerability disclosure policy
      (private email or GitHub Security Advisory), supported versions,
      response SLA.
- [ ] **`.github/ISSUE_TEMPLATE/`**: bug + feature templates.
- [ ] **`.github/PULL_REQUEST_TEMPLATE.md`**: reminds contributors to
      run the test gate + reference an ADR if behaviour-changing.
- [ ] **`LICENSE` audit**: confirm it's present and clearly stated.
      Conventional choices for a hosting platform are AGPL-3.0 (forces
      fork modifications to be open-sourced) or Apache-2.0 (permissive).
      Pick deliberately.

Effort: ~4 hours.

### PR 3 — Per-component independent development

Each major subdir (`backend/`, `frontend/admin-panel/`, `frontend/tenant-
panel/`, `packages/api-contracts/`) should be developable in isolation
without standing up the full cluster.

- [ ] **`backend/README.md`**: `npm install && npm test && npm run dev`
      one-liner. Document the existing `k8s-client.ts` mocked-mode for
      development without a real cluster (most modules already accept `k8s`
      deps as injected interfaces — formalise the mocked path).
- [ ] **`frontend/admin-panel/README.md`** + **`frontend/tenant-panel/
      README.md`**: vite dev server commands. Add `VITE_API_URL` env
      override so a contributor can run the frontend against a stub or
      remote API, not just the in-cluster reverse-proxy path.
- [ ] **`packages/api-contracts/README.md`**: role of the shared Zod
      schema package; how to add a new contract without breaking
      consumers; the build + publish flow (private workspace package, no
      separate npm publish).
- [ ] **Architecture diagram in top-level README**: mermaid block showing
      Traefik → backend → CNPG → tenant pods. A glance is worth 1000
      words of prose.

Effort: ~6 hours.

### Out of scope for now

These are nice-to-haves but not blocking OSS readiness. Revisit after the
three PRs above land + a few forks have opened issues telling us what's
actually friction:

- `docker compose` for backend-only local dev (no k3s required). Useful for
  API hackers who don't want to learn kubernetes.
- A `Makefile` or `justfile` task runner abstraction over the scattered
  scripts.
- Demo cluster or hosted preview environment (way down the line).
- Vendored published Helm chart (`hosting-platform`) that wraps
  bootstrap.sh + the overlays. Probably premature until v2 stabilises.

### Non-goal

**Not aiming for a turnkey OSS-distribution like Argo or Backstage.** The
platform is feature-rich and opinionated — fork-and-modify is the realistic
contribution model, not deploy-as-vendored-product. Honest documentation of
what "easy to fork" means (and doesn't) is more valuable than over-
engineering toward a flat zero-friction install that doesn't fit the actual
contributor model.
