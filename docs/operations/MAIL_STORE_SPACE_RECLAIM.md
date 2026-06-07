# Reclaiming disk space after bulk mail deletion

> Companion runbook to the [ADR-046](../architecture/adr/ADR-046-stalwart-blob-store-stays-rocksdb.md)
> watch-item. Applies to Stalwart's Default (RocksDB) blob store.

## The behavior (measured, 2026-06-06/07)

Deleting mail does **not** promptly free disk. Empirical: 40k messages
(8.7GB of blobs) were expunged on an otherwise idle test cluster and the
blob store stayed **byte-identical for 11.5 hours** — not one of the 138
blob files was removed, and the WAL was static, meaning Stalwart's
background purge had not even deleted the blob *keys* in that window.

Why — the reclaim chain has four stages and an idle server stalls at
every one of them:

1. **Blob-key purge** — Stalwart's periodic store purge removes
   unreferenced blob keys. Cadence observed to be longer than 11.5h.
2. **Memtable flush** — key tombstones reach SSTs only on write
   pressure or a process restart.
3. **Compaction** — tombstones must compact down the levels; driven by
   new write traffic (or RocksDB's ~30-day stale-file TTL on idle data).
4. **Blob-file deletion** — a `.blob` file is removed only when **zero**
   SSTs reference it. Stalwart does not enable RocksDB blob garbage
   collection, so partially-dead blob files (mixed live/deleted mail —
   the realistic case) are never proactively rewritten. Stalwart also
   never calls manual compaction (verified against v0.16.5 source).

Net: deleted-mail space returns organically only under sustained new
mail traffic, with the 30-day TTL as the idle backstop.

## When you actually need the space back (rare)

Typical trigger: offboarding a tenant with a very large mailbox while the
mail node is under disk pressure. Otherwise, do nothing — monitoring
(storage cards + disk alerts) and node headroom absorb normal churn.

Procedure (maintenance window, minutes of mail downtime):

1. **Confirm the blob keys are purged.** Wait for Stalwart's store purge
   to have run after the deletion (give it a day), or restart the
   Stalwart pod and wait one purge cycle. Forcing compaction *before*
   key-purge reclaims nothing.
2. **Scale down**: `kubectl -n mail scale deploy stalwart-mail --replicas=0`
   (suspend the Flux `platform` Kustomization first so the scale sticks:
   `kubectl -n flux-system patch kustomization platform --type=merge -p '{"spec":{"suspend":true}}'`).
3. **Manual compaction** with RocksDB's `ldb` against the data dir on
   the mail node (one-shot pod or host binary matching the RocksDB
   major version Stalwart ships):
   `ldb --db=/var/lib/stalwart/data --try_load_options compact`
   (repeat per column family if needed; the blobs CF is the one that
   matters). Fully-dead blob files are deleted as their last references
   are rewritten.
4. **Scale up + resume Flux**; verify mail serves and disk dropped.

Caveat: with blob GC disabled upstream, step 3 only frees blob files
whose *every* message is deleted. Partially-dead files keep their full
size. The upstream fix (enable `blob_garbage_collection` on the blobs
CF) makes both organic and manual compaction reclaim those too — see
the ADR-046 upstream-contribution note.
