# Disaster Recovery (DR) Bundle — Roadmap

**Status update (2026-05-19):** Phase 0 (Audit) + Phase 1 (DR drill) shipped 2026-05-18; **redesigned in same session** to a "bundle everything" model based on operator feedback. The original "operator curates what to bundle" approach was scrapped because it left silent DR risk every time a developer added a new Secret. See "Bundle-everything redesign" section below for the current architecture.

**Status:** Planning (2026-05-18). Phase 0 (differential secrets audit) + Phase 1 (automated DR drill) start immediately. Phases 2–6 sequenced after.
**Owner:** Platform team.
**Related:** [SECRETS_LIFECYCLE.md](SECRETS_LIFECYCLE.md) (current 3-tier secrets model), [TENANT_BACKUP.md](../02-operations/TENANT_BACKUP.md) (per-tenant bundles), [HA_MODE.md](../05-storage/HA_MODE.md) (CNPG + Longhorn HA).

## Bundle-everything redesign (2026-05-19, shipped)

The original Phase 0 design relied on operators curating `BUNDLE_SECRET_LIST` + an allowlist of "secrets that don't need to be backed up." Live E2E on day 1 caught 23 uncovered Secrets on the dev cluster — including `mail/stalwart-secrets`, which was IN the curated list but under the wrong namespace (it lived in `mail/`, the list named `platform/`). This was the canary: every new Secret added to the platform is a fresh DR risk until someone remembers to edit the list. Operator-driven curation is too fragile for a DR-critical surface.

**The redesign**: bundle EVERY Secret in the cluster that isn't auto-managed by a controller (cert-manager TLS, SA tokens, Helm release state, SealedSecrets, CNPG-owned). Decide WHAT TO APPLY at restore time via profile flags, not at bundle time:

- `bootstrap.sh --restore-profile=conservative` (default) → applies `tier-1-platform` only
- `bootstrap.sh --restore-profile=full` → applies tier-1 + tier-2-tenant + unclassified
- `--restore-dry-run` + `--restore-extract-to=<dir>` → preview without applying
- `--override-skip-at-restore` → ignore operator's skip-at-restore decisions
- Operator marks ephemeral entries (session cookies, etc.) as "skip at restore" via the admin UI; the choice rides along inside the bundle's `MANIFEST.json.skipAtRestore[]` so it survives onto fresh clusters

**Single source of truth for the denied predicate**: `backend/src/modules/system-backup/secrets-denylist.ts` (the `isAutoManaged()` predicate) is mirrored as a jq filter at `scripts/lib/secrets-denylist.jq` (used by `bootstrap.sh:bundle_bootstrap_secrets`) and as a ConfigMap-mounted file consumed by the nightly `secrets-backup-cronjob` (`k8s/base/backup/secrets-denylist-configmap.yaml`). All three must agree; `scripts/ci-secrets-denylist-check.sh` enforces parity.

**Bundle format v2**: tar contains per-Secret YAMLs (named `<namespace>__<name>.yaml`) + `MANIFEST.txt` (operator-readable) + `MANIFEST.json` (machine-readable record consumed by the restore profile gating). Each entry carries `restoreTier`, `sha256OfYaml`, and the bundle's `skipAtRestore[]` snapshot. The apply helper at `scripts/lib/apply-secrets-bundle.sh` is shared between `bootstrap.sh` and `make secrets-restore PROFILE=…`.

**No backward compatibility** — there are no production v1 bundles in existence. The old `BUNDLE_SECRET_LIST` + `OPERATOR_KEY_SECRETS` arrays are deleted; old code paths gone.

**UI changes**: red "uncovered" banner is gone (nothing is uncovered if everything's bundled). The 5-bucket chip layout becomes `tier-1-platform / tier-2-tenant / unclassified / skip-at-restore / denied`. The action button on each row is now "Skip at restore" (was "Add to allowlist").

The Phase 1 DR drill harness still applies — it now decrypts a v2 bundle, validates per-entry sha256OfYaml, and parses MANIFEST.json.

---

## Why this exists

The current `secrets-bundle` is a first-aid kit — it covers platform Tier-1 secrets and the daily CronJob (`platform-secrets-backup`) sweeps tenant Secrets in `client-*` namespaces. But "I have the secrets" is not "I can restore the platform". Real disaster recovery from total cluster loss requires:

- **Backup target configs** — without `backup_configurations`, a fresh platform-api has no idea where tenant bundles or WAL archives live.
- **System recovery pointers** — latest CNPG WAL-archive base-backup ID, Longhorn snapshot IDs for system PVCs (mail blob store), `platform_version` pin.
- **Tenant inventory** — snapshot of the `tenants` table + per-tenant pointer to its most-recent `tenant_bundle` in its assigned target.
- **Catalog state** — `workload_repos` table + last-known-good catalog sync rev.
- **External-system credentials** — PowerDNS API key, NetBird setup key, ACME account key.

The key insight: the **DR bundle is an index, not the data**. Tenant content stays in tenant bundles (S3/CIFS), system-db state stays in the WAL archive, Longhorn snapshots stay in their backing store — the DR bundle is a few-MB pointer file that tells a fresh cluster where to find everything.

Today's gap: an operator who runs `make secrets-restore` against a fresh cluster gets a bootable platform-api but no idea where any tenant data is, no DNS provider creds, no NetBird re-enrollment path, no system-db state. The runbook from there is manual and undocumented.

## Confirmed scope

- Tier-1 secrets (existing) + 5 new pointer/state layers (see below).
- DR bundle is **age-encrypted to the operator recipient**, same crypto as today's `secrets-bundle`. Operator's private key lives offline.
- Bundle size target: < 50 MB even for clusters with thousands of tenants. Actual tenant/system data NOT in bundle — only pointers.
- Daily auto-export via CronJob, retained on the active backup target. Operator can `make dr-bundle-fetch HOST=…` for offline copies.
- Full restore via `make dr-restore BUNDLE=… KEY=…` driving `bootstrap.sh --dr-bundle` through ordered phases.
- **Quarterly automated drill** that actually executes end-to-end restore in DinD — a DR procedure that has never been executed isn't a DR procedure.

Out of scope (deferred to future): cross-region replication of the DR bundle itself (operator's responsibility today via `secrets-fetch` + offline storage), multi-cluster federation, tenant-data replication.

## Current state assessment

Mapped 2026-05-18 against the worktree at `.claude/worktrees/security-hardening`. The relevant subsystem is already substantial — Phases 1, 2, and 4 of the system-backup module have shipped.

### What exists today

**Backend module** `backend/src/modules/system-backup/` (15 files):
- `secrets-bundle.ts` — exports a fixed `BUNDLE_SECRET_LIST` (8 platform + 1 mail) via in-cluster tar + `age` subprocess
- `pg-dump-{orchestrator,scheduler,job-spawner,routes}.ts` — pg_dump for 2 CNPG clusters (platform `system-db` + mail `mail-db`), optional cron via `systemPgDumpSchedules`
- `wal-archive.{ts,routes}` — per-cluster enable/disable of CNPG barman WAL streaming
- `system-pvc.{ts,routes}.ts` — online-grow for system PVCs
- `service.ts` + `routes.ts` + `sweeper.ts` + `download-{route,token}.ts` — orchestration, 15-min-TTL HMAC download links, audit logging, TTL sweep

**K8s manifest** `k8s/base/backup/secrets-backup-cronjob.yaml`:
- Nightly 03:15 UTC, suspended by default (unsuspended by `longhorn-reconciler` only when a backup target is active — ADR-029 pattern)
- Backs up: 9 platform Secrets + 1 longhorn-system Secret + every Secret in `client-*` namespaces (excludes SA tokens + opt-out annotation) + `longhorn-backup-credentials`
- Subprocess `age -r <recipient>` in-memory tar, S3 or SSH target, 30-day retention

**Admin page** `frontend/admin-panel/src/pages/SystemBackup/SystemBackupPage.tsx`:
- 7 tabs: Secrets Bundle, System Databases, System DB Storage, Stalwart BLOB (placeholder), Longhorn Snapshots, WAL Archive, DR Drill
- DR Drill tab today = runbook text + links to `scripts/integration-system-dr-drill.sh` + verified caveats from a 2026-05-06 manual run

**Tenant restore entry point** `backend/src/modules/backup-restore/routes.ts`:
- `POST /api/v1/admin/restores/carts` creates a per-tenant restore job
- `POST .../carts/:id/items` adds items (file paths, mailboxes, deployments, config-tables)
- Phase 4 ships config-tables executor; others throw `EXECUTOR_PHASE_4_PENDING`

**DR drill harness** `scripts/integration-system-dr-drill.sh`:
- Cold-restore onto fresh VM: exports secrets-bundle + pg_dumps from source, SSH-copies to target VM, runs `bootstrap.sh --secrets-bundle`, restores both PGs via `kubectl exec`
- Verified manually 2026-05-06, caveats documented (Longhorn node tags, pg_dump v17→16.9 compatibility, domain rewrite required)

### Identified gaps

1. **No differential secrets audit** — `secrets-bundle.ts:40` references a test that doesn't exist (`secrets-bundle.test.ts` is missing). The hand-curated `BUNDLE_SECRET_LIST` can drift from cluster reality without any automated detection. A new feature adds a Secret → manifest works fine → DR is silently broken until the next drill.
2. **No automated DR drill** — `integration-system-dr-drill.sh` exists but is operator-triggered. No CI cadence. Caveats from 2026-05-06 (pg_dump v17→16.9 compatibility) suggest the manual procedure isn't reliably repeatable.
3. **CronJob and TS exporter diverge** — `secrets-backup-cronjob.yaml` selects 9 platform Secrets + namespace sweeps; `secrets-bundle.ts:BUNDLE_SECRET_LIST` lists 8 platform + 1 mail Secret. Two sources of truth for "what is a Tier-1 secret". The shell script's namespace sweep catches Tier-2 (good); the TS allowlist is Tier-1 only (intentional). But they don't share code, so any drift is structural.
4. **No backup-target config export** — `backup_configurations` rows hold the credentials needed to reach S3/SSH/CIFS. Lost cluster = lost rows = no way to find any tenant bundle. Currently relies on operator memorising target details.
5. **No tenant inventory snapshot** — the `tenants` table is in system-db, which is in the WAL archive, which we DO have a pointer to. But the chain "bundle → WAL location → restore system-db → query tenants → iterate restore each" is operator-driven, not codified.
6. **No catalog state snapshot** — `workload_repos` are operator-configured at runtime. Lost cluster = lost repo URLs. Tenants can be restored but their deployments can't find image definitions.
7. **No external-system credentials capture** — PowerDNS API keys, NetBird setup keys, ACME account keys live in Tier-1 secrets... if operators remembered to add them. Most are in `platform-secrets` but not segregated from app secrets.

## Phased plan

### Phase 0 — Differential secrets audit (~3 days, starts immediately)

**Goal:** know within 24 hours when a Secret exists in the cluster that isn't covered by any backup mechanism.

**Components:**
- **K8s CronJob** `k8s/base/system-backup/secrets-audit-cronjob.yaml` — runs daily, `kubectl get secrets -A -o json`, subtracts denylist (`kubernetes.io/service-account-token`, `helm.sh/release.v1`, `helm.sh/release.v1.config`, cert-manager TLS issued via `Certificate` CR ownerRef, sealed-secret unsealed copies via `bitnami.com/sealed-secrets-key` ownerRef), asserts every remaining Secret falls into ONE of: (a) `BUNDLE_SECRET_LIST` in TS, (b) namespace matches `client-*` pattern (Tier-2 catch), (c) explicit allowlist in a new `secrets-audit-allowlist.yaml` ConfigMap with a `reason` field per entry.
- **Backend reconciler** `backend/src/modules/system-backup/secrets-audit.ts` — new module that the CronJob calls into via a Job, exposes findings via `GET /admin/system-backup/secrets-audit` for the existing SystemBackup admin page. Returns `{ healthy: bool, uncoveredSecrets: [{ns, name, age, owner}], lastAuditAt }`.
- **Frontend** — new "Coverage" sub-section in the existing Secrets Bundle tab (`SecretsBundleTab.tsx`). Red banner when `uncoveredSecrets.length > 0`, table with one row per uncovered Secret + "Add to allowlist" CTA (creates a row in the ConfigMap with a typed reason).
- **Alerting hook** — when audit finds uncovered secrets for ≥48h, emit a `task-center` entry of kind `secrets-bundle-drift`, surfaces as a red chip in admin panel header.

**Risks:**
| Risk | Sev | Mitigation |
|---|---|---|
| Audit false positives on operator-created one-off Secrets (test creds, debugging) | LOW | The allowlist ConfigMap requires a `reason` field; ops noise is operator-driven |
| CronJob can't list cluster-wide secrets without escalated RBAC | MED | Dedicated ServiceAccount with `secrets: [get, list]` cluster-wide. Audit-logged, super_admin only via admin UI. |
| Helm-managed Secrets carry `helm.sh/release.v1` label which we deny — but the underlying credentials inside are NOT bundled separately | HIGH | Audit explicitly flags `helm-managed-secret-not-bundled` as a category. Operator must either accept (Helm chart can re-create from values.yaml) or add to bundle. |

**Test plan:** unit test the classifier (denylist + allowlist + bundle-list matching) in `secrets-audit.test.ts`. Integration test in DinD that creates a Secret with no coverage → audit detects → allowlist entry resolves → audit clears.

### Phase 1 — Automated DR drill harness (~5 days, parallel with Phase 0)

**Goal:** quarterly autonomous CI run that proves "the bundle, restored, produces a working platform."

**Components:**
- **New script** `scripts/dr-drill.sh` — wraps `integration-system-dr-drill.sh` but designed for CI: ephemeral DinD cluster (via `scripts/local.sh` topology), pulls latest bundle from staging's S3 backup target, runs `bootstrap.sh --secrets-bundle` in the DinD, executes pg_dump restores, runs `./scripts/smoke-test.sh`, asserts all critical pods reach Ready, asserts `GET /api/v1/health` returns 200, asserts at least one tenant's deployments come back up if any tenant data is present in the bundle's pointer set. Reports pass/fail + a structured report (`dr-drill-report.json`).
- **GitHub Actions workflow** `.github/workflows/dr-drill.yml` — runs on cron `0 4 * * 1` (Mondays 04:00 UTC) plus manual `workflow_dispatch`. Fails build + creates GitHub issue labelled `dr-drill-failure` on assertion failure. Posts report to `#platform-ops` Slack (when wired).
- **Frontend** — DR Drill tab (`DrDrillTab.tsx`) gains a "Recent Drill Runs" table populated from a new `dr_drill_runs` DB table that the workflow writes via a webhook to platform-api. Shows last 12 drills + pass/fail + duration + failure-reason.
- **Operator command** `make dr-drill-local` — runs the same harness locally for pre-merge validation.

**Risks:**
| Risk | Sev | Mitigation |
|---|---|---|
| DinD-based drill diverges from real bare-metal restore (kernel modules, /proc layout) | HIGH | The drill validates the FUNCTIONAL path (secrets restore, pg_dump replay, smoke). The bare-metal-specific path (Longhorn node tags, /proc/net/wireguard absence) is documented as covered by the manual quarterly drill on a real Hetzner box. |
| Drill bandwidth — pulling a multi-MB bundle weekly from S3 | LOW | Run on Mondays only, source from the staging cluster's own bundle (already produced daily) |
| Drill flakiness shadows real DR regressions | MED | Quarantine flaky failures into a separate `dr-drill-flaky` label; investigate within 1 week per [[feedback_real_e2e_before_claiming_done]] |
| pg_dump v17 → mail-pg 16.9 compatibility (caveat from 2026-05-06) | KNOWN | Fix in Phase 1.1: pin pg_dump to mail-pg's version OR upgrade mail-pg in the same drill. |

**Test plan:** the harness IS the test. Self-meta-test: a synthetic "broken" bundle (missing one critical secret) MUST cause the drill to fail.

### Phase 2 — Backup target configuration export (~4 days)

**Goal:** the DR bundle includes everything platform-api needs to reach every storage backend.

**Components:**
- **Backend** — extend `secrets-bundle.ts` (or rather: add a sibling `target-config-export.ts`) that serialises `backup_configurations` rows + their decrypted credentials into a JSON blob INSIDE the tar. The S3/SSH/CIFS credentials are already age-decrypt-protected at-rest in the bundle (the whole bundle is age-encrypted to the operator recipient).
- **Restore path** — `bootstrap.sh --dr-bundle` (new flag, alongside `--secrets-bundle`) drives a Phase B that, after secrets are restored, re-creates `backup_configurations` rows via a one-shot Job pod that POSTs to platform-api or directly INSERTs (TBD: route choice in detail design).
- **Admin UI** — Secrets Bundle tab gains a sub-table "Included backup target configs" with name/type/path/last-tested.

**Risks:** Schema drift if `backup_configurations` columns change between bundle-time and restore-time — Phase-2 manifest includes a `schema_version` field; restore refuses with a clear error if versions don't match.

### Phase 3 — System recovery pointer manifest (~3 days)

**Goal:** the bundle carries pointers (not data) to the latest CNPG WAL base backup + Longhorn snapshot IDs.

**Components:**
- **Backend** — `system-pointers.ts` queries CNPG cluster status for `latestBackupID` + WAL location, queries Longhorn for `system_*` snapshots' `archivePath` IDs, queries deploy-rev for current `platform_version`. Emits a JSON `recovery-pointers.json` into the bundle.
- **Restore path** — `bootstrap.sh --dr-bundle` Phase C reads pointers, drives CNPG `Cluster` `recovery` spec with the WAL bucket + base-backup ID, drives Longhorn restore-from-backup CRs for each system snapshot.

**Risks:** WAL replay can take 10+ minutes for a busy cluster. Phase C surfaces progress to the operator (UI + bootstrap stdout).

### Phase 4 — Tenant inventory snapshot (~5 days)

**Goal:** the bundle carries a list of every tenant that existed at bundle-time + their per-tenant most-recent `tenant_bundle` pointer.

**Components:**
- **Backend** — `tenant-inventory.ts` snapshots `tenants` table (id, slug, plan, created_at, status) + JOIN to `tenant_bundles` to pick the most-recent per tenant. ~1 KB per tenant; clusters with 1000 tenants → 1 MB.
- **Restore path** — `bootstrap.sh --dr-bundle` Phase F re-inserts tenant rows (post system-db restore — which Phase 3 already restored), then enqueues a restore-tenant job for each tenant pointing at its bundle's `archivePath`. Restore is parallel-capped (e.g. 5 concurrent per backup target) to avoid throttling the storage backend.

**Risks:** A tenant whose bundle is corrupted blocks its own restore; the inventory tracks individual failures and lets the operator skip/retry per tenant rather than aborting the whole DR.

### Phase 5 — Catalog state + external creds (~3 days)

**Goal:** the bundle carries `workload_repos` URLs + last-known-good catalog sync rev + DNS provider creds + NetBird setup key + ACME account.

**Components:** new `catalog-state.ts` and `external-creds.ts` exporters. These already-exist as rows in `platform_settings` table or as Secrets, but they're scattered. The Phase 5 work is consolidation + audit + restore wiring.

**Risks:** ACME account key import requires the account to still exist at Let's Encrypt — if the platform domain has been migrated, the account is unrecoverable. Document as "if you also migrated domain, re-register".

### Phase 6 — One-button restore + drill on restore (~5 days)

**Goal:** `make dr-restore BUNDLE=… KEY=…` is a single command that drives every phase end-to-end + emits a structured progress report.

**Components:**
- **`bootstrap.sh --dr-bundle`** orchestrates Phases A through G, with operator-overridable flags to skip phases (e.g. `--skip-tenant-restore` for a control-plane-only recovery).
- **Progress UI** — when the new cluster has platform-api up (post-Phase B), the restore can be monitored from `/system-backup/dr-drill?run=…` showing each phase's status.
- **Self-drill on restore** — after restore completes, the same drill harness auto-runs against the recovered cluster + posts a "DR restore verified" report to the operator.

## Suggested additional items

Beyond the core 6 phases, surfaced during the assessment:

1. **Bundle manifest with schema_version on every layer** — every component (`secrets`, `targets`, `pointers`, `inventory`, `catalog`, `external`) is independently versioned in `manifest.json`. Restore refuses mismatched versions with a clear migration message rather than corrupting state.
2. **Bundle integrity verification on every fetch** — `make dr-bundle-fetch` verifies SHA256 + age-decryption round-trip before storing locally; operator catches corruption at retrieve-time not restore-time.
3. **"Recovery time objective" estimation** — bundle includes a `rto-estimate.json` with the bytes-to-pull per layer + WAL replay range + tenant count, so the operator knows whether DR will take 30 min or 3 hours.
4. **DR-bundle vs tenant-bundle dependency graph** — the DR bundle lists every tenant_bundle it references; if a tenant_bundle is purged from S3 but still listed in the DR bundle, the audit catches the drift.
5. **Bundle freshness alerts** — admin UI red banner when the DR bundle is > 48h old (the daily CronJob should keep it current; a stale bundle is a silent DR risk).
6. **Restore-progress webhook** — the DR drill posts intermediate state updates that the admin UI surfaces; operators with eyes-on can see "Phase 4: restoring 47/120 tenants".
7. **`--dry-run` for `bootstrap.sh --dr-bundle`** — validates the bundle is restorable WITHOUT touching the cluster (decrypts, checks pointers reach storage, asserts schema_versions match). Operator-runnable on a laptop before committing.
8. **Geographic redundancy assertion** — when the active backup target's S3 region matches the cluster's region, the audit raises a "DR bundle is in the same blast radius as the cluster" warning. Doesn't block; informational.
9. **Read-only restore preview** — UI surface that decrypts a DR bundle in-memory and shows: tenant count, target count, last WAL archive timestamp, recipient — WITHOUT extracting anything. Useful for operator confidence before committing a destructive restore.
10. **DR rehearsal mode** — operator can request a "rehearsal restore" that boots a parallel cluster with namespace prefix `dr-rehearsal-*`, restores from a chosen bundle, runs smoke + leaves it standing for inspection, with auto-teardown after N hours.

## Cross-cutting concerns

**Audit logging:** Every DR bundle export/fetch/restore writes to `audit_logs` with `actor`, `resource_type='dr_bundle'`, `action`, `outcome`. The download token's HMAC + 15-min-TTL pattern (already proven) extends to DR-bundle fetches.

**RBAC:** Super_admin only for export and restore. The DR drill workflow uses a dedicated ServiceAccount with the narrowest RBAC needed.

**Task-center integration:** DR-bundle export runs as a long-running op with progress modal (mirrors the mail ops pattern from PR #69). Restore phases each emit a task-center entry.

**Feature flag:** `DR_BUNDLE_ENABLED` in `platform_settings` (default true). Operators can disable the daily CronJob if they have an external DR mechanism.

**Bundle storage:** The DR bundle itself is stored on the active backup target (same place tenant bundles live), with a `dr-bundles/` prefix. Operator can also `make dr-bundle-fetch` for offline copies. Retention: 90 days on target, indefinite for the most-recent (so a long-undetected outage doesn't lose the last good bundle to rotation).

**Test strategy:** Every phase ships with unit + integration tests. The DR drill IS the end-to-end integration test for the system.

## Phase dependencies

```
Phase 0 (audit) ─┐
                 ├── independent, both start immediately
Phase 1 (drill) ─┘

Phase 2 (targets) → Phase 3 (pointers) → Phase 4 (inventory) → Phase 5 (catalog) → Phase 6 (one-button)

Phases 2-5 each unblock the corresponding restore phase in Phase 6.
```

Each phase mergeable independently. Phase 0 + 1 alone give a 10x improvement in DR confidence even before Phases 2–6 ship.

## Effort

| Phase | Goal | Estimate |
|---|---|---|
| 0 | Differential secrets audit | ~3 days |
| 1 | Automated DR drill | ~5 days |
| 2 | Backup target config in bundle | ~4 days |
| 3 | System recovery pointer manifest | ~3 days |
| 4 | Tenant inventory snapshot | ~5 days |
| 5 | Catalog state + external creds | ~3 days |
| 6 | One-button restore + drill-on-restore | ~5 days |
| **Total** | | **~28 days** (~5–6 weeks calendar) |

Phase 0 + Phase 1 alone (~8 days) materially close the "silent DR-readiness gap" the original question pointed at.

## Success criteria (per phase)

- **Phase 0**: a new Secret created in the cluster without coverage is detected within 24h; admin UI surfaces an actionable list; allowlist additions resolve audit findings within one tick.
- **Phase 1**: weekly DR drill runs autonomously; pass/fail visible in admin UI; a deliberately broken bundle fails the drill (meta-test).
- **Phase 2**: a fresh cluster, restored from a Phase-2 bundle, has `backup_configurations` populated and can connect to every storage backend without operator intervention.
- **Phase 3**: a fresh cluster, restored from a Phase-3 bundle, has the latest CNPG state replayed within 15 min (typical) of the WAL archive lag.
- **Phase 4**: every tenant from the bundle's inventory appears in the restored `tenants` table; per-tenant restore jobs are queued automatically.
- **Phase 5**: workload_repos URLs, DNS provider creds, NetBird key, ACME account all survive restore.
- **Phase 6**: `make dr-restore BUNDLE=… KEY=…` on a fresh DinD produces a working platform within 30 minutes for a small cluster.

## Reference paths

| File | Role |
|---|---|
| `backend/src/modules/system-backup/secrets-bundle.ts` | Today's Tier-1 secrets exporter (extend in Phase 0) |
| `backend/src/modules/system-backup/{pg-dump-*,wal-archive,system-pvc}.ts` | Existing system backup machinery (extend in Phases 2–3) |
| `backend/src/modules/system-backup/routes.ts` | Admin route surface (extend in Phase 0 + Phase 6) |
| `backend/src/modules/backup-restore/routes.ts` | Per-tenant restore cart (consumer in Phase 4) |
| `backend/src/db/schema.ts:706` | `backup_configurations` columns (Phase 2 input) |
| `backend/src/db/schema.ts:2217` | `storage_snapshots` columns (Phase 3 input) |
| `k8s/base/backup/secrets-backup-cronjob.yaml` | Today's nightly CronJob (extend in Phase 0 to do audit) |
| `frontend/admin-panel/src/pages/SystemBackup/SystemBackupPage.tsx` | 7-tab admin page (extend in every phase) |
| `frontend/admin-panel/src/pages/SystemBackup/DrDrillTab.tsx` | DR Drill tab (extend in Phase 1) |
| `scripts/integration-system-dr-drill.sh` | Today's manual drill script (Phase 1 base) |
| `scripts/local.sh` | DinD harness used by Phase 1 CI drill |
| `docs/04-deployment/SECRETS_LIFECYCLE.md` | 3-tier secrets model (reference) |
| `docs/02-operations/TENANT_BACKUP.md` | Per-tenant bundle architecture (reference) |

## Open questions for the operator

Not blocking the roadmap but worth deciding before Phase 6:

1. **Bundle frequency** — daily is the working default. For very-low-RPO operators we could expose hourly. Worth a setting?
2. **Multi-target redundancy** — should the DR bundle write to multiple backup targets simultaneously by default, or stay single-target?
3. **Encryption recipient rotation** — when an operator rotates their age key, how do we re-encrypt historical bundles? (Probably: don't. New bundles use the new recipient; old ones stay readable by the old key for their retention period.)
4. **External-creds scope creep** — at what point does the DR bundle become a general-purpose platform-config-export? Worth a hard line so it doesn't bloat.
