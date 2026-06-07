# Stalwart BlobStore — FENCED (stays on Default/RocksDB)

> **Status: STALE FEATURE / REFERENCE ONLY — see [ADR-046](../architecture/adr/ADR-046-stalwart-blob-store-stays-rocksdb.md).**
> The admin-panel blob-store card and the `/admin/mail/blob-store*` routes were
> removed on 2026-06-05. The platform stays on Stalwart's **Default (RocksDB)**
> blob store. The backend module is retained with a STALE banner at
> `backend/src/modules/mail-admin/blob-store.ts`.
>
> This document was rewritten from the live 2026-06-05 evaluation. The previous
> revision contained false claims (corrected below) — do not resurrect it from
> git history without reading the corrections.

## Why Default/RocksDB (summary — full reasoning in ADR-046)

- Stalwart's RocksDB backend already runs **BlobDB key-value separation**
  (`blobSize` default 16834): blobs ≥16 KiB live in large append-once `.blob`
  files outside SST compaction. Blob data stays in O(hundreds) of files —
  rsync-standby walks and restic scans stay fast at any message count.
- One restic snapshot captures metadata + blobs as a **single consistent
  unit**. External blob stores split the backup story and create a
  silent-data-loss mode: ingest dedups blobs by content hash, so if blob
  files diverge from the data store, identical re-imports link to missing
  blobs without any error.
- Measured (clean runs, 4 IMAP workers): S3 import 19 msg/s / cold export
  35–42 vs FileSystem 38–43 / 320–480 — too slow for daily tenant bundles.
  CIFS (26 / 101–106) sits between but adds a host kernel mount that must
  exist on every mail-failover candidate node.

## Corrections to the previous revision (all verified live, v0.16.5)

| Previous claim | Reality |
|---|---|
| "Default = mail-pg PG (the configured DataStore)" | The DataStore has been RocksDB since the mail-PG removal. Default = blobs inside RocksDB. |
| "FileSystem = per-Pod local emptyDir" | The path is operator-supplied. On the mail-stack PVC it is durable and exactly as failover-compatible as RocksDB-on-PVC. |
| "The cli UPDATE applies to the in-memory store immediately. No Stalwart restart." | **False.** The update persists to the data store but the running server keeps the old store; `/api/reload` is 404. Only a pod restart applies it. |
| "Stalwart's blob hash is `sha256(uncompressed)` … a 1:1 copy" (migration sketch) | Correct in spirit; precisely: key = base32(blob hash); bytes are LZ4-framed identically on every backend, so byte-copies migrate losslessly (proven: 802/802 sha256-identical fs→S3 and fs→CIFS). |
| CIFS "platform manages credentials + systemd mount" / "provisioned by bootstrap.sh" (code comment) | **Nothing provisions the host mount.** With `hostPath: DirectoryOrCreate` and no mount, blobs land silently on the node's root disk. |
| "Stalwart container runs as root (binds port 25)" (code comment) | It runs as **uid 2000 (stalwart)**. A root-only-writable share mount → `Permission denied`. Working mount opts: `uid=2000,gid=2000,file_mode=0660,dir_mode=0770,vers=3.0`. |

Additional defects found in the switch implementation (kept for whoever
revives it): S3 `region`/`secretKey` are tagged JSON objects
(`{"@type":"Custom","customEndpoint":…,"customRegion":…}` /
`{"@type":"Value","secret":…}`) and there is **no** top-level `endpoint`
field; the Job's self-verify `grep | head -1` reads the nested region
`@type` ("Custom") and fails successful switches; and the runtime CIFS
Deployment patch is stripped by the Flux `platform` Kustomization within
its 1-minute interval — volumes must be declared in git manifests.

## Migration mechanics (validated, for future use)

Blobs are content-addressed and LZ4-framed identically on every backend, so
migrations are byte-copies with a key-layout transform:

| Direction | Transform |
|---|---|
| RocksDB (Default) → anything | **No file-level path.** Blobs live inside RocksDB; extraction requires IMAP/JMAP re-export or `stalwart -e` (ADR-042). This is the one direction without a cheap copy — switching away later means a re-export, which is why the decision was made deliberately now (ADR-046). |
| FileSystem → S3 | Flatten: each file's **basename** (base32 of the full hash) becomes the S3 object key, prefixed by `keyPrefix` verbatim. Fan-out dirs (`<hex>/<hex>/`, non-zero-padded `{:x}` bytes, `depth` levels) are dropped. |
| FileSystem → CIFS/FileSystem | Structure-preserving `cp -a` of the tree; `depth` must match on both sides. |
| S3 ↔ CIFS | Compose the two transforms above. |

Procedure that was proven lossless (802/802 messages byte-identical, twice):
copy blobs → switch BlobStore config → **restart Stalwart** → verify a
fresh APPEND lands on the new backend → sha256-compare a full IMAP export
against the pre-migration export. Never delete the source blobs until the
comparison passes, and never let blob files and the data store diverge
(content-dedup makes divergence silent).

## Operational notes that remain true on Default

- `pvc-mail-stack.yaml`'s 30Gi request is informational — local-path does
  not enforce it; the real limit is the node's disk.
- BlobDB garbage collection is **not enabled** by Stalwart: deleted mail
  reclaims `.blob` space only when no surviving key references a blob file.
  Watch mail-PVC growth under heavy delete patterns (ADR-046 watch-item).
