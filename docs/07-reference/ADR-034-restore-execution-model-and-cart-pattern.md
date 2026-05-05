# ADR-034: Restore Execution Model and Cart Pattern

**Status:** Accepted · 2026-05-05
**Relates to:**
- ADR-028 — backup architecture (component model, tiered initiators, multi-target storage)
- ADR-032 — BackupStore interface + bundle orchestration
- `docs/06-features/BACKUP_COMPONENT_MODEL.md` — bundle layout
- `docs/06-features/RESTORE_SPECIFICATION.md` — earlier (now superseded) spec

**Supersedes:** the "single-shot whole-client restore" path in
`RESTORE_SPECIFICATION.md` §6 — replaced with item-level cart pattern.

---

## Context

The earlier RESTORE_SPECIFICATION (Phase 2) modelled three coarse
scopes: whole-client restore, per-file restore, per-mailbox restore.
Each scope was a separate API endpoint, ran independently, and
managed its own pre-restore snapshot.

That model is wrong for the operator workflow:

1. **Operators rarely restore "everything"** — they're investigating
   "the customer says X is missing", which usually means restoring
   a specific deployment OR a specific domain OR a small file tree.
2. **Operators DO mix object types** — "restore this domain AND its
   mailboxes AND its deployment" is the common case after a botched
   migration.
3. **Per-scope endpoints duplicate the orchestration** — pre-restore
   snapshot, audit-log, partial-failure handling, polling. With three
   endpoints we have three slightly-different copies of each.

Plesk's restore UI demonstrates a workable alternative: browse the
backup, **add items to a cart** (like a shopping cart), execute the
cart sequentially. Failures stop the cart; the operator inspects,
fixes, resumes.

This ADR locks down the cart-based execution model so the per-type
executors can be built against a stable contract.

---

## Decisions

### 1. Restore is a CART of typed items, not a SCOPE

A restore is modelled as `restore_jobs` (one row per cart) plus
`restore_items` (one row per planned operation). Each item carries:

- `type: files-paths | mailboxes-by-address | deployments-by-id | domains-by-id | config-tables`
- `selector: jsonb` — type-specific (paths array, address array, …)
- `bundleId` — the source bundle for this item (different items in
  one cart MAY come from different bundles, e.g. "yesterday's domain
  config + last-week's mailbox state")
- `state: pending → applying → done | failed`

**Rationale.** The cart is the user's mental model. We keep one
orchestrator and one audit trail. Mixed-type carts are first-class.

### 2. One cart, one pre-restore snapshot

The cart's first item that touches **mutable** state (anything other
than a no-op verify) triggers a pre-restore snapshot of the affected
client. The snapshot is recorded on the `restore_jobs` row and
covers ALL subsequent items in the same cart — operators don't pay
the snapshot cost N times for a cart of N items.

**Rationale.** Snapshot cost is real (a full PVC tarball + DB-row
dump). One per cart is the right balance; the operator opens the
cart, plans, executes, and either everything is good or the
snapshot rolls back the whole cart.

**Trade-off.** A failure in item N+1 still has to either succeed
on retry or trigger a rollback of items 1..N. We choose **retry-first
with manual rollback** — the operator chooses when to roll back via
an explicit button; partial restores aren't auto-undone.

### 3. Sequential execution

Items in a cart execute in **order of insertion**, one at a time.
No parallelism. This is the simplest model and matches the operator's
mental flow ("restore the domain config first, then the mailboxes,
then the deployment").

**Trade-off.** A cart of 50 file-path items takes 50× the time of a
single item. Phase 4.x can introduce a `parallelGroup` field that
lets independent items run concurrently (different files in the
same archive: parallelisable; mailboxes spanning different domains:
parallelisable; per-deployment vs per-domain: dependency order).
For Phase 4.0 sequential is fine.

### 4. Per-item idempotent re-execute on failure

A failed item can be re-executed without rolling back successful
items earlier in the cart. The executor must be idempotent at the
object level:

- **files-paths**: tar -xzf overwrite-mode, no-op if the path
  already matches the bundle.
- **mailboxes-by-address**: `stalwart-cli account import`
  replace-mode (drops existing mailbox first).
- **deployments-by-id**: INSERT … ON CONFLICT UPDATE.
- **domains-by-id**: INSERT … ON CONFLICT UPDATE + same for
  `dns_records`. Triggers DNS reconciler exactly once at end.
- **config-tables**: per-table INSERT … ON CONFLICT UPDATE; never
  DELETE rows that exist in the live DB but not in the bundle (to
  avoid the "I'm restoring just one table and it nuked unrelated
  rows" surprise).

**Rationale.** Idempotency lets the operator re-run a stuck cart
without "have I already done this?" anxiety. The cart is the
authoritative state; the live system converges.

### 5. Pull-pattern download for files (mirror of Phase-3 upload)

The files-paths executor needs to read `archive.tar.gz` from the
off-site target and apply selected paths to the live tenant PVC.
Following the same pattern as the Phase-3 capture path:

- A short-lived HMAC **download** token authorises a tenant-namespace
  Job to pull a specific bundle's archive.tar.gz over HTTP from
  platform-api.
- The Job runs `curl --output - … | tar -xzf - -- <path-list>`
  against the tenant PVC mounted at `/dest`.
- platform-api streams from BackupStore.readComponent into the
  HTTP response — no buffering on the platform-api side.

The endpoint is `GET /api/v1/internal/bundles/:bundleId/components/:component/:artifactName?token=<hmac>`.

**Rationale.** Symmetry with Phase 3 capture. The Job never sees
S3/SSH credentials. Tokens are bound to (bundleId, component,
artifactName) so they're not replayable elsewhere.

### 6. Mailbox restore is a Job in the mail namespace

Same pattern as mailbox capture (Phase 3): Job in `mail` namespace,
streams archive from platform-api, calls `stalwart-cli account
import` per address. Replaces the existing mailbox if present
(operator opted in by adding to cart).

### 7. Deployment + domain restores are in-process platform-api

These are pure DB operations (apply rows + trigger reconcilers).
No Job needed. Executor runs in platform-api against the orchestrator's
existing module entry points (deployments/service.ts.upsert,
dns-records/service.ts.bulkApply).

### 8. Cart progress is polled, not push

Phase 4.0: client polls `GET /admin/restores/:cartId` every 2s.
WebSocket-based progress is Phase 4.x.

**Rationale.** Restore is operator-driven (low frequency); polling
is sufficient. WebSockets add a real-time path that's worth its
complexity only when many concurrent operators watch many concurrent
restores.

---

## Out of scope (deferred)

- **Roll-back-to-pre-restore-snapshot button** — Phase 4.x.
- **Cross-bundle merge** — picking item A from bundle 1 + item B
  from bundle 2 is allowed by the schema but the UI doesn't surface
  it in 4.0.
- **Per-table column-level restore** — too niche; operator opens the
  config dump JSON and manually applies.
- **Parallel item execution** (`parallelGroup`) — Phase 4.x.
- **WebSocket progress** — Phase 4.x.
- **Client-panel self-service restore** — out of scope; Phase 5.

---

## Consequences

**Positive.**
- One orchestrator, one audit trail, one pre-restore-snapshot path.
- Mixed-type carts are first-class.
- Operator workflow matches Plesk (the platform's reference UX).

**Negative.**
- Per-item idempotency is a stricter contract than the prior
  scope-shaped spec required. Each executor needs to handle the
  "object already exists" branch; we don't get to assume an empty
  destination.
- Cart-level pre-restore snapshot means a cart with one item also
  pays the full snapshot cost — which is fine, but the UI must
  signal "this restore will snapshot first, click confirm".

---

## Implementation order

1. Migration: `restore_jobs` + `restore_items` schema.
2. `api-contracts/restore.ts` — cart CRUD + bundle-browse + item types.
3. Backend `backup-restore/` module:
   - cart CRUD routes
   - bundle-browse routes (list files / mailboxes / deployments / domains / config-tables in a given bundle)
   - per-type executors (5)
   - sequential executor loop
4. Internal-download endpoint (mirror of upload).
5. Admin-panel cart UI (browse + add + execute).
6. Integration scenarios per type.

Each step is mergeable independently and unit-testable in isolation
against the stable contract this ADR locks down.
