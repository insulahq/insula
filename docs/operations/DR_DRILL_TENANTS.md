# DR Drill — Tenant-Bundle Recovery on a Rebuilt Cluster

> **Status:** Phase 1 (design spike) in progress. This document is the living plan +
> drill log for proving that tenant data survives a total cluster loss and can be pulled
> back from offsite bundles onto fresh hardware.
>
> **Public-repo rule:** never paste live hostnames, mailbox addresses, IPs, node names, or
> secrets here. Redact to `example.test` / `<apex>` / `<dr-target-host>` and RFC-5737 IPs.

---

## 1. Why this exists — the failure-scenario matrix

The long-term goal is that **every common failure scenario has (a) a proven recovery path
for critical data and (b) a convenient, operator-visible, actionable admin-panel operation**.
This drill closes the biggest remaining validation gap (tenant-bundle recovery onto a *new*
cluster), and this table is the master tracker for the whole program.

| # | Failure scenario | Recovery mechanism | Data-path validated? | Operator-UX (admin panel) |
|---|------------------|--------------------|----------------------|---------------------------|
| S1 | **Single node loss** (server/agent node dies) | Mail-DR failover/failback (dr-watcher); Longhorn replica rebuild (HA mode); stateless reschedule | ✅ mail-DR data-plane GREEN (rc.9); HA replica rebuild covered | Mail-DR card (failover/failback buttons, node-readiness gate). Node status in security-hardening. |
| S2 | **Complete cluster loss** — platform layer | Cold-restore (`dr-restore.sh`: etcd snapshot + PG dump + secrets bundle + Longhorn volumes) **or** bundle DR (`dr-restore-bundle.sh --mode full`) | ✅ platform layer drilled by `integration-system-dr-drill.sh` (stops at admin login) | `dr-restore*.sh` are CLI/runbook today — **no one-button admin-panel operation yet** (gap) |
| S3 | **Complete cluster loss — tenant data** | Per-tenant offsite bundle → restore-cart (whole-client) onto rebuilt cluster | ❌ **THIS DRILL** — not yet a validated suite | Restore-cart UI exists for live clusters; **post-rebuild path unproven** |
| S4 | **Cross-cluster tenant migration** (cheap multi-region: move tenant A→cluster B) | Same bundle-as-transport mechanics as S3, but target cluster is healthy & different | ❌ shares S3 foundation; not yet drilled | Restore-cart + target-node pick; multi-region orchestration UX TBD |
| S5 | **Accidental tenant deletion / data corruption** | Restore-cart from bundle, re-create deleted client, operator picks target node | Partially (live-cluster restore-cart validated in `integration-tenant-bundles-*`) | Restore-cart UI (ADR-034) |

**This document covers S3 first** (it is the hardest and most valuable gap), and is
explicitly structured so the same harness extends to **S4** (cross-cluster migration) with
a healthy target cluster instead of a freshly-rebuilt one.

---

## 2. This drill (S3): objective & success criteria

**Objective:** after a total cluster loss, an operator rebuilds on fresh hardware and
recovers **each tenant's user-visible data from their offsite bundles**.

**Success criteria — asserted on the *rebuilt* cluster, user-visible only:**

- Tenant website serves the pre-disaster `index.html` — **SHA256 match** (curl the ingress).
- Mail: pre-disaster message subjects present in the restored mailbox (JMAP/IMAP round-trip).
- Add-on DB (MariaDB/Postgres): pre-disaster row count matches.
- Every restore reports `status: completed` — **never `partial`** (hard-fail on `partial`,
  per the standing integration rule).

---

## 3. Building blocks (reuse, don't rebuild)

| Piece | Source | Role |
|-------|--------|------|
| Fresh-VM bootstrap + platform pg_restore | `scripts/integration-system-dr-drill.sh` (wipe → bootstrap → pg_restore → admin login) | Stage 1 (rebuild platform) — the drill **stops here today** |
| Bundle-based platform DR (partial/full: CNPG recovery + mail-stack PVC) | `scripts/dr-restore-bundle.sh` → `backend/src/modules/dr-restore/` | Alternative Stage 1 (more "from-bundle") |
| Tenant-bundle capture (whole-client → offsite restic) | backup orchestrator + `scripts/integration-tenant-bundles-*.sh` | Stage 0 seed/capture |
| Restore-cart API (`POST /admin/restores/carts` → `/items` → `/execute`) | `backend/src/modules/backup-restore/routes.ts` (ADR-034 cart pattern) | Stage 2 per-tenant recovery |
| "Whole client" restore incl. deleted-client → pick target node | `docs/features/RESTORE_SPECIFICATION.md` | The capability under test |
| Offsite bundle storage (per-tenant restic, S3/SSH) | BackupStore + backup-rclone-shim | Proves bundles survive cluster loss |

---

## 4. End-to-end flow (stages)

**Stage 0 — Seed & capture (on the live SOURCE staging cluster):**
1. Create ≥2 probe tenants with real user-visible data: a website (files PVC with a known
   `index.html`), ≥1 mailbox with known messages, one add-on DB with known rows.
2. Trigger a **whole-client bundle** for each → offsite BackupStore (restic). Assert
   `status == completed`.
3. Record fingerprints: `SHA256(index.html)`, mail subjects, DB row count, bundle IDs/versions.

**Stage 1 — Rebuild platform on the throwaway VM** (reuse `integration-system-dr-drill.sh`):
wipe target VM → `bootstrap.sh --secrets-bundle` → CNPG healthy → restore platform DB →
admin login works. *(Method decision — pg_restore vs `dr-restore-bundle.sh --mode full` —
resolved in Phase 1.)*

**Stage 1.5 — Re-provision tenants (required; NOT automatic).** For each tenant whose rows
came back via `pg_restore`, the operator must re-create the K8s layer before any data overlay:
1. `POST /admin/tenants/:id/provision` → Namespace + Quota + NetPol + **empty PVC** + file-manager.
2. Re-deploy the tenant's workloads (Deployments are not auto-recreated).
3. Trigger `reconcileIngress` (edit a route / re-provision) so the site is reachable.
> This is the operator-UX gap (see §12): today it's a manual per-tenant sequence with no
> one-button "recover tenant from bundle."

**Stage 2 — Recover tenant data from bundles (the NEW part):** for each probe tenant, via
the restore-cart API on the *rebuilt* cluster: create cart → add the item **set**
(`files-paths` for the site, `mailboxes-by-address` for mail, `config-tables`) → execute →
poll to terminal state → assert `status == done`. This pulls each component from the
**offsite** restic BackupStore (creds decrypted from restored `backup_configurations` rows) —
the thing we're proving.

**Stage 3 — Assert user-visible recovery + teardown:** curl the tenant site (SHA match),
JMAP/IMAP mail round-trip, add-on-DB row count; then re-wipe / release the throwaway VM.

---

## 5. Phase 1 — design spike (de-risk before writing the harness)

A single-tenant, hand-driven pass that answers the questions that decide the harness shape.
**Answers filled in as the spike resolves them.**

| Q | Question | Answer (Phase 1) |
|---|----------|------------------|
| Q1 | After `pg_restore`, tenant rows exist but data is empty. Does restore-cart restore *into* an existing tenant, or only re-create a deleted client? | **Existing tenant only.** `POST /admin/restores/carts` 404s if the tenant row is absent (`backup-restore/routes.ts:88-89`). Deleted-client re-create + `recreate.target_node` are **spec'd but NOT implemented** (`RESTORE_SPECIFICATION.md` §4.x, Phase 4.x). → **S3 works via pg_restore** (rows come back); **S4 cross-cluster does NOT** (target cluster lacks the row) — recorded as a real platform gap. |
| Q2 | Can the operator pick a target NODE for the restore, and does it work when the bundle's original node doesn't exist? | **No target-node field today.** The files-paths executor **auto-finds the node where the PVC is already attached** (`findNodeAttachingPvc`, `executors/files-paths.ts:118,281`). Implication: the tenant's **PVC must already exist and be attached** before restore — so the workloads must be **re-provisioned (empty) first** (see linchpin below). On a single-node rebuild this is unambiguous. |
| Q2b | **Linchpin:** does the tenant reconciler auto-recreate namespaces/Deployments/**empty PVCs**/mail accounts from restored DB rows (so restore-cart has somewhere to overlay into)? | **NO — recovery is operator-triggered, not automatic. VALIDATED LIVE (Spike 1a): `POST /admin/tenants/:id/provision` re-creates a bindable empty Longhorn PVC and the restore-cart overlays the offsite bundle into it (SHA match).** Only `reconcileAllTenantQuotas()` runs on startup (`app.ts:758`). Re-provisioning requires explicit calls: **`POST /admin/tenants/:id/provision`** (`runProvisionNamespace` → Namespace+Quota+NetPol+**empty PVC**+file-manager; `k8s-provisioner/service.ts:871`, `applyPVC` creates fresh on 404 at `:588`) or `POST /admin/namespace-integrity/sweep`. **Workload Deployments are NOT auto-recreated**; **Ingress is NOT auto-rebuilt** from `ingress_routes` (needs a `reconcileIngress` trigger, `domains/k8s-ingress.ts:145`). Mail is a **single shared `mail-stack-data` PVC** (`mail` ns, `mail-pvc.ts:27`), not per-tenant. |
| Q3 | Stage-1 restore method: `pg_restore` (system-dr-drill) **or** `dr-restore-bundle.sh --mode full`? | **Reuse `integration-system-dr-drill.sh` (pg_restore) as-is.** It restores platform DB + secrets and stops at admin login — it does **not** restore the mail-stack PVC or tenant data. That is *correct* for a "from-bundles" drill: mail is recovered **per-tenant from each tenant's bundle** (Stage 2, `mailboxes-by-address`). The platform-wide mail-stack PVC restore (`dr-restore-bundle --mode full` / `mail/stalwart-snapshot-restic-repo`) is a *separate* recovery path and is out of scope for the bundle drill. |
| Q4 | After secrets-bundle restore, can the fresh cluster reach the offsite BackupStore to pull tenant bundles? | **Confirmed yes.** The restore-cart executor decrypts restic creds directly from restored `backup_configurations` rows (`s3AccessKeyEncrypted`/`sshKeyEncrypted`, `backup-restore/shared.ts:98-151`); per-tenant restic repo password is `HKDF(PLATFORM_ENCRYPTION_KEY, "restic-tenant-<id>")`. Both the rows (via pg_restore) and `PLATFORM_ENCRYPTION_KEY` (via the secrets bundle, `apply-secrets-bundle.sh`) come back on the rebuild → offsite pull works. |

**Data-source facts (confirmed):** restore-cart items are **per-type** — `files-paths`,
`mailboxes-by-address`, `config-tables`, `deployments-by-id`, `domains-by-id` — there is no
single "whole client" item, so recovering a client = adding the right **set** of items. All
data comes from the **offsite restic BackupStore** (not live snapshots; a Longhorn snapshot is
taken only as pre-restore rollback safety for files items). A partial item failure sets cart
`status=failed` + `lastError` — so the drill asserts cart `status == done`.

**Reordered Stage 2 (consequence of Q1/Q2):** on the rebuilt cluster, per tenant —
(a) let the reconciler re-provision empty namespaces/PVCs from restored rows, (b) create a
restore cart, (c) add `files-paths` + `mailboxes-by-address` + `config-tables` items,
(d) execute → poll → assert `done`.

**Spike procedure — split into 1a (cheap, no wipe) then 1b (full wipe):**

- **Spike 1a — prove the tenant-restore *mechanic* without a cluster wipe (staging).**
  Seed one *self-created* probe tenant with a known `index.html` (SHA recorded) → capture its
  files bundle offsite (`completed`) → simulate loss by **deleting the tenant namespace** →
  `POST /admin/tenants/:id/provision` (empty PVC) → restore-cart `files-paths` from the offsite
  bundle → assert the file's SHA matches. Proves re-provision-empty + overlay-from-offsite
  without the expensive rebuild. Only touches a throwaway probe tenant.
- **Spike 1b — full wipe + rebuild (throwaway VM).** Run `integration-system-dr-drill.sh`
  (wipe → bootstrap+secrets → pg_restore staging's platform DB → admin login) so the rebuilt
  box carries staging's DB + reaches staging's offsite store; then re-provision + restore the
  probe tenant from its offsite bundle and assert SHA. Proves fresh-bootstrap-reaches-offsite
  end-to-end and yields the RTO.

Record answers/timings here; then build the harness (Phase 2). **Scope for the spike:
files/website first** (clearest user-visible proof); mail + add-on DB are the next iteration.

---

## 6. Phase 2 — the harness + platform-ops CLI (after spike)

**Sequencing (per operator decision 2026-07-05):** _extend the cheap no-wipe validation to
mail + add-on DB first_, **then** build the harness — and **every DR op must also be a
`platform-ops` CLI command**, not just a bash script. So the recovery orchestration lives in
`platform-ops` (TypeScript, in-pod, signed) and the harness *calls* it:

- **platform-ops CLI (new):** e.g. `platform-ops dr tenant-restore --tenant <id>
  --bundle <id|latest> [--components files,mailboxes,config] [--target-node <n>]` that
  orchestrates provision → build restore-cart items → execute → wait → verify. This directly
  closes gap **G1** (orchestrated recover) at the CLI layer; the admin-panel action (G3) can
  later call the same code path.
- **Harness `scripts/integration-dr-tenant-restore-e2e.sh`** (registry tier **`manual`** —
  destructive, dedicated VM, never CI-gated): seeds files+mail+db → captures → simulates loss →
  invokes `platform-ops dr tenant-restore` → asserts user-visible recovery. Reuses the
  `integration-tenant-bundles-*` seed/capture logic and `integration-system-dr-drill.sh`.
- Registry entry + `ci-integration-coverage.sh` update to keep the guard green.

**Order:** (1) cheap validation of the mail + add-on-DB restore-cart mechanic (staging,
non-destructive) → (2) `platform-ops dr tenant-restore` command → (3) harness that drives it →
(4) full destructive 1b run as validation.

**Progress (2026-07-05):**
- Mail restore-cart bug (G0) **fixed + reviewed SAFE + unit-tested**, on `development`
  (`8349cc3f`). Awaiting live validation at the consolidated RC (operator decision:
  build-more-then-one-RC).
- **DEV cluster (testing box) is degraded** — admin login returns 401 `INVALID_TOKEN` despite a
  valid active admin + correct clock, plus webmail-reconcile drift. Blocks DEV as the fast
  validation loop; flagged separately. Validation will happen on staging via the RC.
- Orchestrator design fixed: new backend route **`POST /api/v1/admin/dr/tenants/:id/recover`**
  reuses the existing provision + restore-cart endpoints via **`app.inject`** (no refactor);
  `platform-ops dr tenant-restore` is a thin client to it. Closes G1; the same route is the
  admin-panel action later (G3). DB re-import (G4) is a follow-on item on the same route.

---

## 7. Phase 3 — validation

One full destructive run on the throwaway VM. Capture RTO. Assert all Stage-3 criteria.
Append the run to the **Drill Log** below. Flip the registry note to a validated status and
cross-reference this doc.

---

## 8. Environment & safety

- **Throwaway VM:** the dev/testing box (`<dr-target-host>`) is explicitly wipe-authorized as
  the DR target. Never point the drill at a staging/production node.
- **Destructive:** wipes + bootstraps a VM. Run in a maintenance window; the source cluster is
  read-only except a triggered bundle export.
- **Offsite creds:** the source cluster's BackupStore + operator age key must be configured
  (staging has both). **Never commit these** — they live in secrets, not the repo.
- **Redaction:** all logs captured to scratch must `sed`-redact IPs/hostnames before any are
  pasted into the repo, PRs, or this doc.

---

## 9. Relationship to cross-cluster tenant migration (S4)

The tenant bundle **is the transport**: "restore tenant onto cluster B" and "migrate tenant
from cluster A to cluster B" are the same primitive with a different target-cluster state
(fresh-rebuilt vs healthy). Once S3 is validated, S4 is: point Stage 2's restore-cart at a
**second healthy cluster** and (for a live move) suspend/retire the source tenant after the
target verifies. The multi-region orchestration UX is tracked as a separate follow-up.

---

## 10. Open questions / risks

- Restore-cart on a fresh cluster may surface real platform gaps (node-remap, BackupStore-cred
  timing, `partial` bundles) — that is the point of the drill; budget for fixes.
- Throwaway-VM provisioning + a ~1–2h destructive cycle per run.
- Offsite bundle pull is bandwidth-bound (like Longhorn volume restore).
- Operator-UX gaps (S2/S3 have CLI/runbook recovery but no one-button admin operation) are
  tracked in the matrix and are follow-ups beyond the data-path validation.

---

## 11. Drill log

_Append one entry per real run: date, RC/commit, target VM, stages reached, PASS/FAIL,
RTO, notes. Redact identifiers._

- **Spike 1a — PASS** (staging, no wipe). Probe tenant → seed known `site/index.html` →
  capture files bundle to offsite S3 (`completed`) → **delete namespace** (Longhorn PVC
  destroyed) → `POST /admin/tenants/:id/provision` (fresh empty PVC; file confirmed gone) →
  **admin-scoped restore-cart** (`POST /admin/restores/carts` → `files-paths` item → execute)
  → recovered file **SHA256 == original**. Proves re-provision-empty + overlay-from-offsite.
  Confirmed live: the `/admin/restores/carts` path needs no tenant-user login; re-provision
  yields a bindable empty Longhorn PVC that the executor overlays into. _(Phase 1a)_
- **Spike 1 (mail) — FOUND CRITICAL BUG G0** (staging, no wipe). Self-provisioned probe tenant
  + domain + mailbox → seeded 20 msgs → captured mailboxes bundle (`completed`) → destroyed all
  msgs → restore-cart `mailboxes-by-address` **FAILED (404)**. Root cause = capture(restic-stream)
  / restore(per-address `.mbox.tar.gz`) format mismatch (see §12 G0). **Fix in progress.** The
  seed→capture→loss→restore harness path itself works; the executor is the defect.
- **Add-on DB — GAP G4 confirmed** (no `databases-by-id` restore executor; `.sql` recoverable via
  `files-paths` + manual import). Cheap validation of the DB path deferred behind the mail fix.
- **DR tenant-restore E2E — GREEN 13/0 (DEV, 2026-07-05).** `integration-dr-tenant-restore-e2e.sh`
  against the DEV cluster (image `backend:…-da1204f`): probe tenant → seed known site file + a
  12-message mailbox → capture whole-client bundle **completed** → delete namespace + destroy mail
  → **recover via `POST /admin/dr/tenants/:id/recover`** (provisioned=true, cart done) → **FILES
  SHA matches + all 12 mail messages restored**. Proves the mail-restore fix (G0), the recover
  route (G1), and the harness — end to end, user-visible. DEV had to be prepared: minted an admin
  JWT in-pod (DEV login is broken — see §12 note), added + activated an S3 backup config, and
  **assigned it to the `tenant` shim class** (the shim was `assignedClasses:[]` → capture got
  connection-refused until assigned). The first run's "imap-sync SSL EOF" was a cascade of the
  down shim, not a mail defect — it cleared once the shim served the class.
- **DR tenant-restore E2E — GREEN 13/0 (STAGING, rc.10, 2026-07-06).** Same suite against the
  shipped release (`backend:2026.7.1-rc.10`, Flux `a1ac0761`): capture completed → loss → recover
  route (provisioned=true) → FILES SHA + all 12 mail restored. Now validated on BOTH DEV and the
  release environment. First staging attempt failed at setup on a **stale `Succeeded` stalwart-probe
  pod** (leftover from a prior mail test — `restartPolicy:Never` sleep ended; `kubectl apply` won't
  recreate it, so `exec` failed → "mailbox never JMAP-reachable"). Harness fix: delete any
  non-Running probe pod before applying a fresh one + a real Running assertion. Not a DR/mail defect.

---

## 12. Operator-UX gaps (product findings from Phase 1 grounding)

**🔴 G0 — CRITICAL BUG (found live 2026-07-05): `mailboxes-by-address` restore-cart is broken
for all current bundles.** The capture (`tenant-bundles/components/mailboxes.ts`, ADR-047
Phase-2 rewrite) writes ONE whole-tenant **restic stream** (`restic-stream` / `maildir.tar`),
but the restore executor (`backup-restore/executors/mailboxes-by-address.ts`) still downloads
**legacy per-address `<addr>.mbox.tar.gz`** artifacts (`:248-254`) → **HTTP 404** for
`kind:addresses`; for `kind:all` it lists artifacts and strips `.mbox.tar.gz` (`:184-185`),
finds none, and silently reports "bundle contains no mailboxes." So **operator-facing mail
recovery from a bundle does not work.** It was hidden because `integration-tenant-bundles-jmap-full-e2e.sh`
restores via restic *directly*, never through the cart executor. **Fix:** rewrite the executor's
restore Job to `restic restore` the `restic-mailboxes/<tenantId>` repo (repo password
`HKDF(PLATFORM_ENCRYPTION_KEY,"restic-tenant-<id>")`) → extract `maildir.tar` →
`jmap-restore.py` per address — mirroring the `files-paths` executor's in-Job restic pattern and
what the jmap harness does manually. Live repro: probe tenant, 20 msgs seeded+captured
(`completed`), destroyed, restore-cart `failed` with
`mailboxes-restore: curl: (22) 404 …/components/mailboxes/<addr>.mbox.tar.gz`.


The drill's code-grounding surfaced that **the data is recoverable, but recovery is not yet a
convenient, operator-visible, one-button operation** — the goal for every failure scenario.

**Gap G1 — no orchestrated "recover tenant from bundle."** On a rebuilt cluster, fully
recovering one tenant is a manual sequence: `provision` → re-deploy workloads → `reconcileIngress`
→ create restore-cart → add one item per component → execute → verify. Multiply per tenant.
There is no single "recover this tenant (or all tenants) from the latest offsite bundle onto
node X" action.

**Gap G2 — target-node pick ✅ IMPLEMENTED (2026-07-06); deleted-client re-create still open.**
`provision` now accepts `targetNode` (validates the node exists, persists `tenants.nodeName`,
stamps a `nodeSelector` on the file-manager pod so the tenant's data lands there), and the DR
recover route forwards it — so a tenant can be recovered onto an operator-chosen node
(`k8s-provisioner/service.ts:applyTargetNodePlacement`). **Still open:** restore-cart 404s if the
tenant ROW is absent (`RESTORE_SPECIFICATION.md` Phase 4.x re-create-on-node), so **cross-cluster
tenant migration (S4)** onto a *different* cluster that never had the row still needs the
deleted-client re-create path. Target-node is the placement half; re-create is the remaining half.
_Live validation of target-node pending (see §13)._

**Gap G4 — ✅ IMPLEMENTED (2026-07-06, on `development` → next RC).** A tenant's add-on DB
(MariaDB/Postgres) IS captured — `database-predump.ts` dumps it to
`databases/<deploy>/predump-<db>-<bundleId>.sql`, folded into the files restic snapshot. Added a
new restore-cart item type **`databases-by-id`** (`executors/databases-by-id.ts`) that, after the
`files-paths` restore lands the `.sql` on the PVC, re-imports each dump into the RUNNING DB pod via
the existing `importSqlFromPvcFile` primitive. Exact-bundle dump matching (point-in-time), graceful
skip when the DB workload isn't running / no dump (not a failure), fails only on a real import
error. Wired into the recover route after `files-paths`. Needed enum migration `0068` (the
`restore_items.type` column is a Postgres enum). _Live validation pending (needs a DB-restore
harness — see §13)._

**Gap G3 — DR restore is CLI/runbook only (S2/S3).** `dr-restore*.sh` / `integration-system-dr-drill.sh`
are operator-run scripts; there is no admin-panel DR console showing "cluster lost → rebuild →
restore platform → restore N tenants" as guided, actionable steps with progress.

**Recommended follow-ups (tracked, beyond this drill's data-path validation):**
1. **`POST /admin/dr/tenants/:id/recover`** (and a batch `…/recover-all`) that orchestrates
   provision → redeploy → reconcileIngress → auto-built restore-cart from the newest bundle,
   with a target-node param — closes G1 and, by adding re-create, G2.
2. **Admin-panel DR console** surfacing the failure-scenario matrix (S1–S5) with a one-button
   action + live progress per scenario — closes G3 and satisfies the "operator-visible &
   actionable" goal.
3. Extend the restore-cart execute path to **re-create an absent tenant on an operator-chosen
   node** (implements `RESTORE_SPECIFICATION.md` Phase 4.x) — unlocks S4.

The drill (Phases 2–3) validates the data path with the primitives that exist **today**; these
follow-ups turn a validated-but-manual runbook into the convenient operations the platform
should ship.

---

## 13. Live-validation plan for G2 + G4 (next cycle)

G2 (target-node) and G4 (`databases-by-id`) are implemented + unit-tested + reviewed, but — unlike
the mail fix (a bug in a path the existing harness already drove) — they are **new capabilities
that need new harness coverage** and a deploy (they ride the next RC). To validate live:

- **G4 — add-on-DB restore round-trip** (new harness / extension). Seed a tenant with an add-on DB
  (a catalog `type='database'` deployment) → insert **known rows** → capture a bundle (the `.sql`
  predump lands in the files snapshot) → **change/drop the rows** (simulate corruption; keep the DB
  workload RUNNING — the recover-route flow doesn't re-deploy workloads, so this targets the
  *live-tenant DB restore* case) → restore-cart `databases-by-id {kind:'all'}` → **assert the rows
  are back**. Registry tier `manual`.
- **G2 — target-node placement.** Extend `integration-dr-tenant-restore-e2e.sh` with an optional
  `TARGET_NODE` env: pass `targetNode` in the recover body → after recovery assert the tenant's
  storage PVC + file-manager pod landed on that node (`kubectl get pod -o wide` / PV nodeAffinity).

Both need the code deployed first (an RC, like the mail-fix cycle). Sequence: build the two harness
pieces → cut an RC → run on staging → flip this section to validated.

**Built + G4 DEV-validated (2026-07-06):** `integration-dr-database-restore-e2e.sh` (G4, new,
**GREEN 11/0 on DEV**) + the `TARGET_NODE` extension of `integration-dr-tenant-restore-e2e.sh` (G2),
both registered. **The G4 harness caught a real, pre-existing bug** — through three wrong predump-path
theories: `databases/<deploy>/` → `exports/` (what the capture *intends*, but its `mv` is a silent
no-op) → the **actual** `database/<engine>/<name>/` (the DB pod's own storage subPath, where the dump
is stranded because `database-predump.ts` passes the wrong subPath; broken since ADR-047, latent
because nothing restored DB dumps until now). Final executor is robust: `find`s the predump wherever
it is + imports it in place. DEV run: deploy MariaDB → seed 25 rows → capture → delete rows →
`databases-by-id` → 25 rows restored. Also: add-on DBs need a plan bigger than Starter (quota).
Next: cut rc.11 → validate G4 + G2 (multi-node target-node test) on staging.
