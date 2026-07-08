# Cross-cluster tenant migration (R20)

> Move one or many tenants from **cluster A** to **cluster B** — with **no
> preparation on A**. Cluster B mounts A's tenant backup target read-only,
> lists the tenants it finds, and imports single/all. Each import re-creates the
> tenant from its newest off-site bundle (preserving the original id + namespace)
> and restores its data straight from A's target.

Audience: the operator standing up a new region, consolidating clusters, or
evacuating a cluster before decommission. UI: **Admin → Disaster Recovery →
Migrate Tenants**. API: `POST /api/v1/admin/migration/{list-tenants,import}`.

## How it works

A tenant's off-site bundle is **cluster-agnostic** — keyed by `bundleId` +
`meta.json.tenantId`, no cluster in the path. So cluster B can open A's bundles
directly given access to A's target; the tenant row, namespace, plan/region,
domains, and mailboxes are all reconstructed from `meta.json`. Nothing is written
to A — the source is mounted **read-only**.

The import reuses the DR recover engine (`recreateTenantFromBundle` + post-restore
reconcile of ingress / DKIM / workloads), pointed at the migration source target.

## Prerequisites

- **B can reach A's target.** A tenant bundle target (S3 or SFTP) that A wrote to,
  reachable from B with A's credentials. Two ways to give B access:
  - **Existing cluster B:** add A's target as a backup config on B (Admin →
    Backups → Targets → New), using A's endpoint/bucket/prefix + credentials. You
    do **not** need to assign it as B's backup destination; it's only read here.
  - **Fresh cluster B (cross-node DR):** bootstrap B from A's age-encrypted
    secrets bundle — it carries A's target coordinates, so the target is already
    present. (This is the same secrets-bundle path used by the tenant-restore DR
    drill.)
- Each tenant you migrate must have at least one **completed** bundle on that
  target (`status: completed`).
- Plan + region ids referenced by A's tenants must **exist on B** (seed the same
  catalog/plans/regions first — the import fails fast with a clear error if a
  plan/region id is missing, rather than a raw FK error). The plans only need to
  **exist** (FK) — their **parameters need not match A's**: the bundle captures
  each tenant's resolved effective quotas and the import pins them as explicit
  overrides, so resources are preserved regardless of B's plan definitions.

## Migrate (UI)

1. **Admin → Disaster Recovery → Migrate Tenants.**
2. **Source target:** pick the backup config that points at A's target (or paste
   its config id). It is used read-only — no writes to A.
3. **List tenants:** B scans the target and lists every tenant it finds — name,
   primary email, newest bundle, size, components. A tenant that **already
   exists on B** is shown but not selectable (it would be skipped to avoid an
   overwrite).
4. **Select** the tenants to import (or choose *import all discovered*).
5. **Preview (dry-run)** shows exactly what would be imported / skipped.
6. **Import.** Each tenant is re-created from its newest bundle and its data is
   restored. The per-tenant results table shows recreated / status / any error.

## Migrate (API)

```bash
# 1. list tenants on the mounted source target
curl -sk -X POST "$B/api/v1/admin/migration/list-tenants" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"targetConfigId":"<A-target-config-id-on-B>"}'

# 2. import selected (or scope:"all")
curl -sk -X POST "$B/api/v1/admin/migration/import" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"targetConfigId":"<id>","scope":"selected","tenantIds":["<t1>","<t2>"],"dryRun":false}'
```

`dryRun:true` resolves the target set + presence without importing.

## After import — cutover + decommission (operator)

The import restores the tenant on B, but the platform will not steal traffic from
a live A automatically. Finish the move deliberately:

1. **Verify on B:** the tenant is `active`, its site loads, mailboxes present.
2. **DNS cutover:** re-point the tenant's ingress so traffic lands on B. In the
   CNAME chain `blog.<apex>` → `<slug>.ingress.<apex>` → node → IP, update the
   `<slug>.ingress.<apex>` A/AAAA (or the apex A/AAAA) to **B's ingress IP**
   (`ingress_default_ipv4/6` on B). Do this at your DNS provider / provider group.
3. **Mail:** if the domain's DNS moved, re-publish MX + the DKIM/SPF records for
   B (the import regenerates DKIM; the records must be served from the new DNS).
4. **Decommission on A:** once B is serving and verified, delete the tenant on A
   (Admin → Tenants → delete). This frees A's namespace + resources. A's off-site
   **bundles are retained** (the delete cascade only drops A's local rows) — prune
   them from the target manually if you want the storage back.

## Residual gaps (surfaced, operator-actionable)

- **Cross-region DNS:** if B uses a different `ingress_base_domain`, the CNAME
  chain target differs — update client CNAMEs, not just the ingress A record.
- **Secrets re-encryption:** TLS/secret material in a bundle is encrypted with
  **A's** `PLATFORM_ENCRYPTION_KEY`. If B's key differs, secrets that can't be
  decrypted are surfaced as a residual gap — re-enter them on B (or re-issue
  certs via cert-manager).
- **CIFS/SMB source:** the read-only mount uses the direct S3/SFTP store. A CIFS
  source is reached via the shim; assign it to a spare shim class if needed.

## Verify

`scripts/integration-migration-e2e.sh` proves the core end-to-end on one cluster:
capture a probe tenant's bundle → delete the tenant fully → `list-tenants`
surfaces it (alreadyPresent=false) → `import` re-creates it from the off-site
bundle with no local row → namespace back + site file SHA matches. DEV-validated
2026-07-08.
