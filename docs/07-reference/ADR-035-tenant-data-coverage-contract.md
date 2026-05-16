# ADR-035 — Tenant Data Coverage Contract

**Status:** Accepted (2026-05-06)
**Supersedes:** None
**Related:** ADR-028 (backup architecture), ADR-032 (BackupStore + bundle orchestration), ADR-034 (restore cart pattern)

## Context

Tenant Bundles (per-tenant off-site backups, see ADR-028 / ADR-032)
are forward-only: every component (`files`, `mailboxes`, `config`,
`secrets`) hard-codes which DB tables, PVCs, Secrets, and external
resources it captures. When a developer extends tenant-facing
functionality — adds a new DB table holding tenant config, mounts a
second tenant PVC, generates a new Secret type, or wires in an
external service — the new dimension is **silently excluded** from
bundles unless they remember to wire it into a component.

We have already been bitten by this. The CI schema-audit was added
2026-04-22 after a quarter of merges that quietly stopped backing up
ziti / zrok / mTLS provider tables. The audit catches DB tables; PVCs
and Secrets had no equivalent gate.

## Decision

Adopt a **Tenant Data Coverage Contract** with three reinforcing
layers:

### 1. Static registry (`component-registry.ts`)

Each bundle component declares what it owns:

```ts
{
  name: 'config',
  tables: ['clients', 'domains', /* … 18 tables */],
  pvcs: [],
  secretTypes: [],
  externalResources: [],
}
```

Tables and Secret types are matched by exact value; PVCs accept a
`{ns}` template substitution.

### 2. CI audits (`scripts/ci-tenant-bundles-*.sh`)

Two pre-merge audits, both wired into `Backend CI`:

- **schema-audit** — fails when a new `tenant_id`-FK'd table lands
  in `db/schema.ts` without being added to `CONFIG_DUMP_TABLES` or
  `CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES`.
- **resource-audit** — fails when a new
  `createNamespacedPersistentVolumeClaim` /
  `createNamespacedSecret` call site lands in `backend/src/**` without
  an explicit `// backup-coverage: …` marker.

Both audits run on every PR.

### 3. Runtime drift report (`GET /admin/tenant-bundles/coverage`)

Returns the static registry plus a runtime diff: every
`information_schema` table with a `tenant_id` column that no component
claims surfaces as an `orphanTable` in the response. Operator UI
(`/tenant-backup?tab=coverage`) renders this with a red callout.

The drift report catches the case where the schema-audit was bypassed
(force-merge, rebase that lost the file) — the gap shows up in
production within minutes.

### 4. End-to-end coverage harness (`integration-bundle-coverage.sh`)

Provisions a tenant, populates non-trivial state across multiple
captureable dimensions, captures a bundle, runs `verify`, asserts the
bundle's `rowCounts` includes every table where we wrote rows.
Required-for-release. The safety net for the registry refactor — if a
new dimension is added without wiring into a component, this harness
fails.

## PR checklist

Every PR that touches tenant-facing functionality must answer (see
`.github/pull_request_template.md`):

- [ ] No new tenant DB tables, OR they're in `CONFIG_DUMP_TABLES`
  and the corresponding component-registry entry.
- [ ] No new tenant PVCs, OR they're claimed by an existing
  component (or a new one is registered).
- [ ] No new tenant Secrets, OR they're captured by the secrets
  component (or excluded with a documented reason).
- [ ] No new external state, OR a new `BundleComponent` is
  registered.
- [ ] If a new dimension was added, `integration-bundle-coverage.sh`
  is extended to populate + assert it.

## Consequences

**Positive:**
- New tenant data dimensions cannot ship invisibly. CI breaks; the
  operator UI shows red.
- Operators have a single source of truth for "what is in the bundle?"
  visible from the Tenant Backup admin page.
- The registry is consumable by future auditing tooling (e.g. a
  "compute bundle size estimate" endpoint).

**Negative:**
- One more file to update when adding tenant data: the registry.
  Mitigated by the CI audits — failure mode is "PR rejected with a
  clear message", not a silent drop.
- Drift detection at runtime touches `information_schema` per call.
  Cheap (one query, cached 60 s by the React Query layer); becomes a
  problem only at >1 000 tables. Today: ~33.

**Neutral:**
- The `ComponentOwnership.tables` array duplicates the
  `CONFIG_DUMP_TABLES` array in `config.ts`. The schema-audit asserts
  they stay in sync.

## Implementation

Shipped 2026-05-06 across:
- `backend/src/modules/tenant-bundles/component-registry.ts`
- `packages/api-contracts/src/tenant-bundles.ts` (BundleCoverageResponse schemas)
- `backend/src/modules/tenant-bundles/routes.ts` (`GET /admin/tenant-bundles/coverage`)
- `frontend/admin-panel/src/pages/TenantBackup.tsx` (Coverage tab)
- `scripts/ci-tenant-bundles-resource-audit.sh`
- `scripts/integration-bundle-coverage.sh`
- `.github/pull_request_template.md`
