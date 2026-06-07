# ADR-046: Stalwart blob store stays on Default (RocksDB); blob-store switch feature fenced

**Status**: ACCEPTED
**Decision date**: 2026-06-05
**Supersedes**: the operational guidance in the pre-rewrite `STALWART_BLOB_STORE_MIGRATION.md` (Default→S3 at ~5 GiB) and the admin-panel blob-store switch surface.

## Context

Stalwart's BlobStore is a singleton selecting where message bodies live:
`Default` (inside the configured DataStore — RocksDB on this platform),
`FileSystem` (directory tree), `S3`, or CIFS (FileSystem on a kernel CIFS
mount, platform-managed). The platform shipped an admin-panel card +
`GET/PATCH /admin/mail/blob-store` routes to switch backends at runtime.

A full live evaluation on the testing cluster (2026-06-05; Stalwart v0.16.5,
real Hetzner object storage + storagebox CIFS, 800-message corpora,
per-message sha256 verification) established the facts this decision rests on.

### Measured (clean, dedup-immune runs; 4 IMAP workers, cold-cache exports)

| | FileSystem (local-path PVC) | S3 (Hetzner fsn1) | CIFS (storagebox) | Default/RocksDB |
|---|---|---|---|---|
| IMAP import | 38–43 msg/s | 19.3 | 26.4 | ~same as FileSystem (historical 23–45) |
| IMAP export (cold) | 320–480 msg/s | 35–42 | 101–106 | n/a (not separately benched) |

- fs→S3 and fs→CIFS migrations are **byte-lossless** (proven twice each;
  content-addressed base32 keys; LZ4 framing identical across backends).
- **No size threshold** routes small blobs away from an external blob store —
  every message body lands there. `RocksDb.blobSize` (default 16834) is the
  RocksDB-internal BlobDB key-value separation threshold, nothing more.
- Stalwart's RocksDB backend **already enables BlobDB** on the blobs CF —
  blobs ≥16 KiB live in large append-once `.blob` files outside the SST
  compaction path. Blob *data* is therefore already separated from
  compaction churn, in O(hundreds) of files.
- Ingest **dedups blobs by content hash**: if blob files are deleted out from
  under the data store, identical re-imports silently link to missing blobs.
  Blob files and the data store must always be backed up / restored / moved
  as a unit.

### Why the alternatives lose

1. **FileSystem blobs** create one file per message — millions of inodes at
   maturity. The 5-min standby rsync (mail HA's core mechanism) and the
   30-min restic snapshot must stat-walk every file every tick; at 1–5 M
   messages the walk alone approaches the replication cadence. RocksDB keeps
   the walk at O(hundreds) of files forever.
2. **S3 blobs** are 8–10× slower on the export path that daily tenant
   bundles use, split the backup story in two (restic no longer captures
   message bodies), and add a hard external dependency under the most
   critical data.
3. **CIFS blobs** add a host kernel mount that must exist and be healthy on
   every mail-failover candidate node, conflict with the mail-mobility
   pipeline, and the shipped switch implementation was inoperative (below).
4. **Backup unity** is the strongest argument: today one restic snapshot of
   `/var/lib/stalwart/data` captures metadata + blobs as a consistent unit.
   External blob stores require a second backup system plus cross-system
   restore consistency — and the dedup behavior above makes divergence a
   silent-data-loss mode, not a recoverable error.

### The switch feature was broken as shipped (all verified live)

1. `stalwart-cli update BlobStore` persists config but the running server
   keeps the old store (`/api/reload` is 404 on v0.16.5) — only a pod
   restart applies it. The Job + docs claimed "online, no restart".
2. The S3 cli field shapes are schema-invalid (`region`/`secretKey` are
   tagged objects; there is no `endpoint` field) — the switch can never have
   worked.
3. The Job's self-verify grep reads the first `"@type"` in the JSON — a
   successful custom-endpoint S3 switch reports as failed.
4. Nothing provisions the CIFS host mount (the code comment crediting
   bootstrap.sh is false), and the container runs as uid 2000, not root —
   a conventionally root-mounted share is unwritable.
5. The runtime Deployment patch (CIFS hostPath) is stripped by the Flux
   `platform` Kustomization (1-minute interval) — reverting the pod
   mid-traffic. Runtime patches to Flux-owned workloads are structurally
   incompatible with the platform's GitOps drift correction.

## Decision

1. **The platform stays on Stalwart's Default (RocksDB) blob store.** No
   per-size tuning is required (`blobSize` default stands).
2. **The blob-store switch surface is fenced**: the admin-panel card and the
   three `/admin/mail/blob-store*` routes are removed. The backend module and
   api-contracts schemas were initially retained with STALE banners, then
   fully deleted in the 2026-06-07 remnant cleanup — this ADR and
   STALWART_BLOB_STORE_MIGRATION.md carry the findings; code is in git
   history (PR #192 and the follow-up).
3. Staying is **not lock-in**: byte-lossless migration to FileSystem/S3 was
   proven and documented. Triggers to revisit: blob volume materially beyond
   ~20 GiB per node with measured RocksDB degradation, or stateless-HA
   Stalwart returning to the roadmap (requires S3).
4. Any future revival must: declare volumes in git manifests (never runtime
   Deployment patches), order config-update *before* the restart-causing
   change, use the correct object field shapes, and parse self-verify with a
   real JSON parser.

## Watch-items on Default

- Stalwart does **not** enable RocksDB BlobDB garbage collection: a `.blob`
  file is reclaimed only when no surviving key references it, so
  long-retention mail interleaved with deleted mail accrues space
  amplification. **Empirically confirmed 2026-06-06/07**: expunging 40k
  messages (8.7GB of blobs) on an idle cluster freed zero bytes over
  11.5 hours — the blob store stayed byte-identical and the WAL static
  (Stalwart's purge had not even deleted the blob keys). Stalwart also
  never triggers manual compaction (v0.16.5 source). Operator procedure:
  [MAIL_STORE_SPACE_RECLAIM.md](../02-operations/MAIL_STORE_SPACE_RECLAIM.md).
  Upstream contribution (enable blob GC on the blobs CF) proposed —
  see the PR/forum links in the runbook era.
- The 30-min restic copy of the live RocksDB dir remains the accepted
  crash-consistency compromise (unchanged by this ADR; see ADR-042 for the
  deferred logical-export path).

## References

- Evaluation + bench harnesses: session artifacts 2026-06-05
  (`integration` candidates: blobbench / blobbench-cifs / cifs-final);
  full findings in the rewritten
  [STALWART_BLOB_STORE_MIGRATION.md](../06-features/STALWART_BLOB_STORE_MIGRATION.md).
- [ADR-042](ADR-042-stalwart-logical-export.md) — logical export (deferred).
- `project_stalwart_storage_perf_2026_05_22` — why mail storage is
  local-path, not Longhorn.
