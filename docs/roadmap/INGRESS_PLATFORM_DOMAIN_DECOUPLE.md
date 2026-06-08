# R16 — Decouple INGRESS_DOMAIN from PLATFORM_DOMAIN + turnkey apex rename

**Status:** Scoped 2026-06-08 (planning). Not started.
**Decisions locked (operator, 2026-06-08):**
1. **Naming** — keep `ingress_base_domain` meaning the **INGRESS / CNAME-target**
   domain (its current behaviour); add a **new `platform_domain`** setting for
   the **apex / brand**. No `ingress_domain` rename.
2. **Rename scope** — **full turnkey apex rename** (a single admin action moves
   every platform-owned hostname + TLS cert + DNS, end to end).
3. **Intent** — implement the clean separation as **groundwork, default-equal**
   (`platform_domain` seeds from today's `ingress_base_domain`); the
   `INGRESS_DOMAIN ≠ PLATFORM_DOMAIN` path is supported but lightly exercised.

---

## 1. Problem — one value, two jobs

Today a single setting, `ingress_base_domain` (+ the Flux `${DOMAIN}`
substitution var), is overloaded:

| Role | Where |
|------|-------|
| **CNAME target** — tenants point `shop.customer.com → {slug}.<base>`; the value shown by `GET /platform/ingress-base-domain` | `ingress-routes/service.ts:246`; tenant panel |
| **Platform apex** — `webmail.<base>`, `mail.<base>`, reserved subdomains | `webmail-settings/service.ts:165-172`; `mail-*-reconciler`; `system-tenant/reserved-subdomains.ts` |
| **Routing A/AAAA** — `ingress_default_ipv4/ipv6` the CNAME chain resolves to | `ingress-routes/service.ts` |
| **Static manifest hosts + cert SANs** — `${DOMAIN}` baked at deploy time | `platform-cluster-config` ConfigMap via Flux `postBuild.substituteFrom` |

Consequences:
- The brand apex cannot be renamed without forcing every tenant to re-CNAME.
- The audited "rename leaves stale" surfaces (webmail cert, `stalwart.<apex>`
  ingress+cert, Bulwark `JMAP_SERVER_URL` env, longhorn/tunnels, cors-origins)
  are pinned to static `${DOMAIN}` and don't follow a DB-side rename.

## 2. Target model

| Setting | Role | Consumers | DNS owner |
|---------|------|-----------|-----------|
| **`platform_domain`** (NEW) | Apex / brand | `admin\|tenant\|webmail\|mail\|stalwart\|longhorn.<platform_domain>` + all platform-service certs | operator's brand zone |
| **`ingress_base_domain`** (unchanged name, INGRESS role) | Tenant CNAME target + routing | `{slug}.<ingress_base_domain>`, DNS-verification target | routing/infra zone |
| **`ingress_default_ipv4/ipv6`** | A/AAAA for the routing zone | ingress chain | routing/infra zone |

**Migration invariant:** on upgrade `platform_domain := ingress_base_domain`
(current value) → **zero behaviour change**. Operators may then move either
independently.

## 3. Work breakdown

### PR-1 — Settings split + plumbing (no behaviour change)
- DB migration: seed `platform_domain` from `ingress_base_domain`.
- `config/index.ts`: surface `PLATFORM_BASE_DOMAIN` (already partly present) as
  the apex; `ingress_base_domain` stays the CNAME base. Bootstrap writes both.
- `getIngressSettings`/`getWebmailSettings` expose both; api-contracts updated.
- **No consumer repointed yet** — pure plumbing + tests for the seed/back-compat.

### PR-2 — Repoint consumers to the correct domain
- **Apex → `platform_domain`:** `defaultWebmailUrl`/`defaultMailHostname`,
  `reserved-subdomains`, `stalwart-domain-reconciler`, `mail-acme-override-route`.
- **CNAME/routing → `ingress_base_domain`** (already correct; assert + lock with
  a test): `ingressCname` derivation, `/platform/ingress-base-domain`, DNS
  verification target, tenant-panel label.
- Admin UI: two clearly-labelled fields (**Platform apex** vs **CNAME target**) +
  the routing IPs, with help text describing the split.

### PR-3 — Full turnkey apex rename
Make **every** platform-owned hostname + cert + DNS follow `platform_domain`,
removing the static-`${DOMAIN}` dependency for renameable surfaces:

- **3a Webmail** — webmail-router reconciler also manages the `platform-webmail`
  **Certificate `dnsNames`** (host + CORS already done in #260); reconcile
  Bulwark's **`JMAP_SERVER_URL`** env (`stalwart.<platform_domain>`).
- **3b Stalwart mgmt** — make the `stalwart-webadmin` IngressRoute Host + its
  Certificate reconciler-driven from `platform_domain`.
- **3c Panels** — `system-settings/ingress-reconciler` already drives
  admin/tenant Host + cert from `admin_panel_url`/`tenant_panel_url`; the rename
  action rewrites those URLs from `platform_domain`.
- **3d Internal UIs** — Longhorn + private-worker tunnels: convert from static
  `${DOMAIN}` to reconciler-driven (or templated from `platform_domain`).
- **3e Platform DNS automation** — create/replace A/AAAA + ACME records for
  `admin|tenant|webmail|mail|stalwart.<new platform_domain>` via the existing
  PowerDNS sync (today only tenant domains use it).
- **3f Cert orchestration + the rename action** — one `super_admin` endpoint
  (`POST /admin/platform-domain/rename`) + a task-center progress modal that:
  persists `platform_domain` → reconciles all hosts → ensures DNS → waits for
  cert-manager to issue the new SANs → verifies. Idempotent, LE-rate-limit-aware.
- **3g The `${DOMAIN}` ConfigMap tension (design risk — see §5).**

### Cross-cutting
- `scripts/admin-domain-rewrite.sh` → `--platform-domain` and `--ingress-domain`.
- `bootstrap.sh` sets both (equal by default).
- Extend `integration-webmail-platform-e2e.sh` with an
  `INGRESS_DOMAIN ≠ PLATFORM_DOMAIN` scenario; new apex-rename E2E.
- CI guard: fail if code reads `ingress_base_domain` as the apex (re-conflation).

## 4. Migration & back-compat
- `platform_domain` seeds equal → no behaviour change on upgrade.
- Changing `ingress_base_domain` after tenants exist breaks their CNAMEs →
  operator notice + a re-CNAME migration tool (out of scope; flag in UI).
- Webmail/apex cert reissue is subject to Let's Encrypt rate limits (5/week/host)
  → reconcilers must be idempotent and back off; use LE-staging in test loops.

## 5. Key design risk — GitOps `${DOMAIN}` vs a runtime "turnkey" rename
A truly turnkey (admin-button) rename conflicts with the fact that
`${DOMAIN}`-based static manifests + cert SANs are **GitOps-owned** (Flux
`postBuild.substituteFrom` from `platform-cluster-config`). Two ways to resolve:
- **(A) Reconciler-drive every renameable surface** (remove `${DOMAIN}` for
  customer-facing hosts/certs; keep `${DOMAIN}` only for truly-static infra like
  the ClusterIssuer). Clean end-state; larger refactor. **Recommended.**
- **(B) Have the rename action write `platform-cluster-config` + force a Flux
  reconcile.** Smaller code, but platform-api mutating a Flux-substitution
  ConfigMap fights git (the value also lives in the repo → drift), and is
  awkward to make atomic with cert/DNS.
Decision needed at PR-3 kickoff; this SoW assumes **(A)** for renameable
surfaces and leaves the ClusterIssuer + any node-level config on `${DOMAIN}`.

## 6. Testing
- Unit: settings seed/split; apex-consumers use `platform_domain`;
  CNAME-consumers use `ingress_base_domain`; migration back-compat.
- Integration (`integration-webmail-platform-e2e.sh`): `--hostname-rename`
  (exists) + new `--apex-rename` (platform services + certs + DNS follow) +
  `INGRESS_DOMAIN ≠ PLATFORM_DOMAIN`.
- Real-world E2E on staging (multi-node) for the apex rename, gated on LE limits.

## 7. Phasing recommendation
Ship **PR-1 → PR-2** first (the decouple; low-risk, immediately useful) and treat
**PR-3** as its own track (3a→3g) so the high-value, low-risk webmail/stalwart
pieces land before the heavier DNS/cert/ConfigMap automation. Each PR is
independently revertible and leaves the platform working.
