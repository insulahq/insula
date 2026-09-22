# ADR-061 — Tenant mail backup: restic-native per-mailbox capture, one repo per tenant, bundle as a tag

**Status:** Proposed (2026-09-22)
**Amends:** ADR-048 Primitive 2 (JMAP/IMAP Maildir capture streamed as a tarball) — the
capture *transport* is replaced; the Maildir-shaped output tree and master-user proxy auth
are unchanged. ADR-034 (restore cart) — adds a per-mailbox snapshot selector.
**Related:** ADR-035 (tenant data coverage contract — unchanged), ADR-032 (bundle format +
data export — the export path is repaired here), ADR-044 (IMAP MULTIAPPEND engine).

## Context

The `mailboxes` component stores roughly **4.7× the data it needs to**, and the bundle it
belongs to can no longer serve as a tenant data export. Both are consequences of the same
thing: `mailboxes` is the last component still using the pre-restic transport.

### Measured on production (2026-09-22)

One tenant, 4 mailboxes, **15.5 GB** of mail of which one mailbox holds 14 GB
(28,758 messages across 5 folders, ~500 KB average — attachment-heavy):

| | |
|---|---|
| real night-over-night growth of the mail | **0.4 – 6.9 MB** |
| `data_added_packed` restic reports per night | **8.2 GB** |
| repo size for 12 daily snapshots | **94 GB** |
| component wall-clock | 232 – 238 s |

Platform-wide: **40 GB of live mail across 27 tenants is stored as 188 GB** of
`restic-mailboxes` repos.

**The control that rules out restic, the shim and the storage target:** the same tenant's
`files` component, writing to the same backend through the same driver, is **8.4 MB of repo
for 12 snapshots of 8.5 MB each**. `files` was migrated to restic-native capture; `mailboxes`
was not.

### Why the tar stream defeats deduplication

`components/mailboxes.ts` runs `tar cf - .` over a Maildir tree that is **rebuilt from
scratch every night** and pipes it into `restic backup --stdin`. Two things therefore differ
on *every file* each run:

1. `imap_client.py:deterministic_unique()` prefixes each Maildir filename with
   `int(time.time())` — the capture wall clock. Its docstring claims the opposite ("Stable
   for a given (uid, mailbox) pair so re-runs produce identical names").
2. Each message file is written fresh, so its **tar header mtime** changes.

Each altered 512-byte header falls inside a content-defined chunk, so only the interiors of
large attachments survive — which is exactly the ~41% the production repo was achieving.

Measured locally on an 800-message / 278 MB corpus, night 2 adding 12 messages (~1.2 MB):

| variant | night-2 `data_added_packed` |
|---|---|
| A — current tar-stream | **155.0 MB** |
| B — stable filenames only | 139.2 MB |
| C — clamped mtime only | 149.4 MB |
| D — both (`--sort=name --mtime=@0`) | **2.3 MB** |
| E — D + `--compression auto` | 1.5 MB |
| **F — `restic backup <dir>`, filenames and mtimes left alone** | **1.3 MB** |
| G — F + `--compression auto` | 1.0 MB |

Fixing *either* cause alone is worth ~10% and reads as "not the cause". The decisive result
is **F**: the restic-native path needs neither fix, because restic deduplicates per file
content — a renamed file with identical bytes costs a tree entry, not the data.

### The export no longer contains files or mail

`ADR-032` made a bundle a self-contained prefix on the target, and that is what the tenant
data export streams. Listing a completed production bundle's prefix today returns **three
objects**:

```
<bundleId>/components/config/db-rows.json.gz      2 921 B
<bundleId>/components/secrets/tls.json.gz.enc    13 773 B
<bundleId>/meta.json                              2 535 B
```

`files` and `mailboxes` exist only as restic snapshots — `files` since its restic-native
rewrite (it never calls `store.writeComponent`), `mailboxes` because the restic-stream
endpoint pipes into `restic backup --stdin` instead. All three export variants (`/export`,
`/zip`, `/export-token`) enumerate `store.listArtifacts(...)`, and `wrapBundleAsDataExport`
does `store.stat(...)` then `if (!stat) continue` — a missing artifact is skipped in
silence. `data-export.ts` contains no restic code path.

So an export is currently ~17 KB of DB rows and TLS secrets, and nothing reports the
omission. `backup_components.artifact_name` still reads `archive.tar.gz` and `__pending__`,
names for objects nobody writes.

> Evidence note: this rests on the production object listing plus those code paths. An
> end-to-end export download was not obtained — the only DEV bundles predate a target
> migration and lack `meta.json`, so `/export` fails in `getMeta` before enumeration.
> Closing that is part of the verification plan below.

### Why there are two repos per tenant

There is no isolation rationale. `deriveResticPassword(secretsKeyHex, tenantId)` places no
component in the HKDF info string, so **one password opens both** `restic-files/<tenantId>`
and `restic-mailboxes/<tenantId>`, and the shim's S3 credentials are bucket-root regardless.
The split is sediment: each component was migrated to restic separately, and the repo layout
followed the migration rather than a decision.

## Decision

### 1. `mailboxes` capture becomes restic-native

The capture Job runs `restic backup` directly against the per-tenant repo, exactly as
`components/files.ts` does. The tar pipe and the `restic-stream` upload endpoint are no
longer used by this component.

The Maildir-shaped output tree, the master-user proxy auth, the IMAP engine and the
`jmap-aux-sync.py` auxiliary capture are **unchanged**.

### 2. One snapshot per mailbox

Each mailbox is captured, snapshotted, and its tree deleted before the next mailbox starts.
Consequences:

- peak ephemeral staging becomes the **largest single mailbox** rather than the whole
  tenant's mail;
- `backup_components` already carries a unique index on
  `(backup_job_id, component, artifact_name)`, so one row per address fits the existing
  schema with `artifact_name = <address>`;
- restoring one mailbox becomes a targeted `restic restore` of that address's snapshot.
  Today it downloads the whole `maildir.tar` to `/tmp/restic-out` and extracts it again to
  `/tmp/maildir-all` — **~31 GB of scratch to restore one mailbox** of a 15.5 GB tenant.

### 3. Compression becomes per-component

`restic-driver.ts` hardcodes `--compression off` for every component, with a rationale
written for tenant *files* ("jpegs, mp4, .gz dumps"). Tenant repos are already format
version 2. Measured on a **1.5 GB sample of a real production maildir tar**, zstd-3 yields
**1.672× — a 40.2% saving**. `mailboxes` moves to `auto`; `files` keeps `off`.

### 4. One restic repo per tenant; the bundle becomes a tag

`restic-files/<tenantId>` and `restic-mailboxes/<tenantId>` merge into one repo per tenant.
Every snapshot carries `bundle=<backupId>` alongside the existing component tag. A bundle is
then a *set of tagged snapshots*, which is the most a bundle can be without staging every
component together (they are captured by different Jobs, in different namespaces, at
different times, and a restic snapshot is one filesystem tree at one instant).

This makes retention (`forget --tag bundle=<id>`), repo statistics, and export uniform, and
costs nothing in isolation for the reason given above.

`meta.json` stays a plain object on the target so bundles remain enumerable without opening
the repo.

### 5. The export streams from restic

`restic dump --archive tar <snapshot> <path>` emits a tar of a directory without
materialising it. The export keeps its exact wire format — `components/<component>/<name>`
entries inside one gzipped, optionally AES-256-CBC-encrypted tar — and only changes where
the bytes come from:

- `files` → `components/files/archive.tar`
- `mailboxes` → one `components/mailboxes/<address>.tar` per mailbox snapshot

A component with no artifact and no snapshot must raise, not `continue`. Silently shipping a
short export is the defect that hid this for two migrations.

### 6. Capture INTERNALDATE and derive the filename from it

`imap-restore.py` parses the Maildir filename's leading integer as the IMAP INTERNALDATE.
Since that integer is the capture clock, **every restored message currently receives the
night the backup ran as its received date**. `imap_client.py` fetches
`(UID FLAGS BODY.PEEK[])` and never asks for INTERNALDATE, so the true date is not captured
at all.

Add INTERNALDATE to the FETCH and use it as the filename timestamp. This is a restore-
fidelity fix in its own right; that it also makes filenames stable is a bonus the decision
no longer depends on.

### 7. The restore cart lists mailbox names

`GET …/browse/mailboxes` (both the admin and tenant routes) builds its list from
`store.listArtifacts(handle, 'mailboxes')`, stripping a `.mbox.tar.gz` suffix — the
pre-restic layout. Since the component writes no store artifacts, the list is **empty**, and
the picker renders "No mailboxes captured in this bundle" for a bundle that captured every
one of them.

The addresses are already on the target: `meta.json` v2 carries
`components.mailboxes.addresses[]` (confirmed populated on production bundles). Browse reads
them from the manifest instead of the object store. This fixes the picker for **existing**
bundles as well as new ones, with no capture-side change, and the cart already renders the
address it is given (`Mailbox: <address>`).

Once per-mailbox snapshots land, browse prefers the per-address snapshot map (below) and
falls back to `addresses[]`.

### 8. `meta.json` v3 — per-mailbox snapshots and an explicit repo layout

`meta.json` is the only thing a foreign cluster reads when it mounts a target read-only
(`listBundleIds()` → `getMeta`, the cross-cluster migration path), so it must be able to
name every snapshot without the originating platform's database. v2 already carries
`components.{files,mailboxes}.sha256`. v3 adds:

- `components.mailboxes.snapshots: { "<address>": "<snapshotId>" }` — supersedes the single
  whole-tenant `sha256`, which stays optional so v2 bundles keep resolving;
- `repoLayout: "per-component" | "per-tenant"` — which repo URI a reader should build.

A bundle without `repoLayout` is `per-component` by definition, which is what makes the
migration below work without touching a single stored byte.

## Migrating existing backups

`buildResticRepoUri(target, tenantId, component)` gains a layout argument, and **every**
caller — restore executors, browse, export, retention/forget, the reclaimer, repo-stats, DR
re-create, cross-cluster import — resolves the layout from the bundle's manifest (or its
`tenant_restic_repo_state` row) instead of assuming today's shape. Nothing reads a
hardcoded path.

**Default: no data migration.** New bundles write the new layout; existing bundles keep
resolving to `restic-files/<tenantId>` and `restic-mailboxes/<tenantId>` and stay fully
restorable, exportable and migratable until they expire under normal retention
(`tenant_backup_v2_settings.retention_days`, default 30 — the settings row is absent on
production, so the default applies). When a tenant's last legacy bundle expires, its legacy
repos hold no referenced snapshots and the existing reclaimer removes them.

**Optional: drop the legacy mail repos immediately.** An admin action that forgets every
legacy `restic-mailboxes/<tenantId>` snapshot and reclaims the ~188 GB now. This is
defensible *for mail specifically* because loss protection does not depend on these repos —
the whole mail store is snapshotted independently every 10 minutes. The cost is precise and
must be stated in the UI: no tenant-scoped mailbox restore from a date earlier than the
first new-layout bundle. Not the default; the operator opts in per tenant or globally.

**Rejected: `restic copy` into the merged repo.** It re-uploads every blob (cross-repo
deduplication needs the destination initialised with `--copy-chunker-params`), and what it
would copy is precisely the badly-deduplicated data this ADR exists to stop storing.

## Compatibility: DR, restore, export, cross-cluster

| path | depends on | effect of this ADR |
|---|---|---|
| **Mail DR** | the whole-store `stalwart-snapshot-restic-repo`, restored by the Stalwart/Bulwark initContainers | **none** — this ADR never touches that repo |
| **Tenant DR re-create** | `meta.json` component snapshot ids, to repopulate `backup_components` for a tenant whose rows were cascade-dropped | preserved and improved: v3 names every mailbox snapshot instead of one tarball |
| **Restore (cart)** | `backup_components.sha256` → `restic restore` | per-address snapshots; a single-mailbox restore stops needing ~31 GB of scratch |
| **Export / data export** | `store.listArtifacts` + `readComponent` | repaired — streams from restic (decision 5); today it silently omits files and mail |
| **Cross-cluster migration** | `listBundleIds()` → `meta.json`, plus a DR key added to the repo | preserved: `meta.json` stays a plain object on the target, and the repo path stays cluster-agnostic (no cluster id in it, unlike the mail snapshot repo). One merged repo means one `restic key add` per tenant instead of two |

Two invariants the implementation must not break, both currently load-bearing:

- **`meta.json` stays an unencrypted object at the bundle prefix.** It is the discovery
  index for a cluster that has the target but not the database.
- **The tenant repo path contains no cluster id.** `buildResticRepoUri` namespaces the
  *mail snapshot* repo by `clusterId` and deliberately does not do so for tenant repos, so
  two clusters can share one target and still migrate tenants between them.

## Non-goals

- **A persistent staging mirror of the mail pool.** Rejected by the operator: it would keep
  a second cleartext copy of every tenant's mail on node disk permanently (~40 GB today),
  and oblige a lifecycle hook to wipe it on tenant deletion.
- **Incremental IMAP fetch.** Follows from the above. A bundle must be COMPLETE because it
  doubles as the tenant data export, and a restic snapshot contains what is on disk — build
  it from only the delta and every unchanged message is recorded as deleted. The primitives
  exist (`imap_client.select()` already returns UIDVALIDITY and UIDNEXT), so this stays
  reopenable if the staging trade is ever revisited.
- **Changing the mail component's schedule.** Out of scope by operator decision.
- **The whole-store mail DR path.** Unchanged and untouched.

## Consequences

**Storage.** ~8.2 GB/night → the real delta, single-digit MB. The per-tenant mail repos fall
from 188 GB toward ~24 GB platform-wide, and stop scaling with retention depth. Existing
snapshots age out under current retention; reclaiming compression on already-stored data
would need a one-time `prune --repack-uncompressed` and is optional.

**Wall-clock.** The nightly upload drops from 8.2 GB to single-digit MB. What remains is the
IMAP fetch, which is unchanged.

**CPU / memory.** restic moves off platform-api and into the short-lived Job, in the same
envelope `files` already proves (`requests 100m/256Mi`, `limits 1500m/1Gi`). Compression
costs CPU only on new data. restic's on-disk cache measured **5.3 MB** against a 94 GB repo.

**Ephemeral disk.** Unchanged in kind — the Maildir already lands in the Job's 50Gi `scratch`
emptyDir. Peak falls from the tenant's whole mail to its largest mailbox.

**Trust boundary.** The capture Job in the `mail` namespace gains a mounted restic-credentials
Secret (mode-0400 tmpfs, ownerRef'd to the Job), where previously it only held an HMAC upload
token. This is the same trade `files` already makes in the tenant namespace, and the
credentials are the shim's in-cluster root keys plus a per-tenant restic password — not the
upstream storage credentials.

**restic metadata.** Per-file capture stores a tree listing every message rather than one tar
node. The first snapshot per mailbox pays it; later snapshots reuse unchanged subtrees.

**Restore.** Per-mailbox and per-message restore become reachable (`restic ls`,
`restore --include`), which the opaque `maildir.tar` could not support.

## Alternatives considered

- **Keep the tar stream, add `--sort=name --mtime=@0` and stable filenames** (variant D).
  Takes night-2 growth to 2.3 MB and preserves the current trust boundary, but leaves the
  ~31 GB single-mailbox restore, leaves the export broken, and requires *both* fixes to be
  correct forever — either one regressing silently costs 98% of the benefit.
- **One snapshot per bundle.** Impossible without staging every component together.
- **`restic mount` the parent snapshot + overlayfs the delta.** Would give incremental fetch
  without persistent staging, but needs FUSE in the Job and an overlay over a network-backed
  mount. Rejected on operational risk.

## Verification plan

1. **Proof of concept on DEV** before any implementation: seed a real mailbox over IMAP,
   capture it both ways against a real restic repo, add a day's worth of messages, capture
   again, and compare `data_added_packed` per run. Green means the new path's second run
   adds the delta, not the mailbox.
2. **Implementation**, then end-to-end on DEV, asserting user-visible outcomes:
   - a full bundle completes — `status: partial` counts as **failed**;
   - the restore cart's mailbox tab lists **addresses**, for a newly captured bundle *and*
     for one captured before the change;
   - **restore of individual components through the cart**: one mailbox by address, a file
     subtree, and a config table — each verified at the destination (IMAP for mail, not the
     job's own success report);
   - an export downloaded through the endpoint and listed with `tar tzvf`, containing
     `components/files/…` and `components/mailboxes/<address>.tar`;
   - a legacy bundle (per-component layout) still restores and still exports after the
     change — the dual-read path is the part most likely to rot silently.
3. Re-run `./scripts/smoke-test.sh` after deploy, and hand back a UI verification checklist.

> DEV prerequisite: all three `backup_configurations` rows on DEV are `active = false`
> following the S3→StorageBox retirement, and the DEV mailboxes hold 0 MB. The end-to-end
> stage needs an active target and seeded mail; the proof-of-concept stage does not.
