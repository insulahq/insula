# ADR-065: Stalwart v1 is a planned mail migration, not a version bump

**Status**: PROPOSED — a living record, revised as upstream releases and our own drills change the facts
**Date**: 2026-10-30 · **Last reviewed**: 2026-10-31
**Related**: ADR-026 (email system), ADR-030 (mail server selection), ADR-031 (role-based multi-node),
ADR-039 (Bulwark webmail), ADR-042 (Stalwart logical export), ADR-044 / ADR-061 (mailbox backup),
ADR-046 (blob store stays RocksDB), ADR-064 (upgrade procedure). Registry: `security/components.yaml`
component `stalwart`, `watch.hold` below 1.0.

## Context

The platform runs Stalwart **v0.16.27** as one pod with a RocksDB data store on a `local-path`
volume (blobs inside it, ADR-046), a warm standby copy for disaster recovery, per-mailbox restic
backups (ADR-061) and an HAProxy DaemonSet in front of the mail ports. Stalwart **v1.0.0** (2026-10-26) and **v1.0.1**
(2026-10-28) are out. The component watch lists v1 as *held*, not *behind*, and this record is why.

There is no security pressure. Upstream supports 0.16.x until **2027-06-01**
(`SECURITY.md` at v1.0.1), and no published advisory affects 0.16.27.

## Findings

Checked against upstream at `stalwartlabs/stalwart` v1.0.1 and `stalwartlabs/stalwart-migrate`
v1.0.4. Items marked *(reported)* come from upstream notes and are still to be measured in our drill.

1. **No in-place upgrade.** At startup v1 reads the store's schema version and refuses a store
   written before 1.0: "The data store was created by a Stalwart version prior to 1.0 … and cannot
   be opened by this version" (`crates/common/src/manager/schema.rs`). Changing only the image
   crash-loops the mail pod on every install. The store is not damaged; mail is down until the
   image is reverted.
2. **The store is tied to the edition.** The same check refuses a store written by the other
   edition (open-source vs Enterprise). The official image is the Enterprise build; a migrated
   store can be opened only by the edition that wrote it.
3. **Data moves with `stalwart-migrate`,** a separate tool: `prepare` (review how the 0.16
   settings convert, record answers), `run` (copy into a new, empty v1 store while 0.16 keeps
   serving — repeatable), `run --final` (0.16 stopped: copy the last changes, finalize, verify),
   `verify`, `rollback`. It needs room for a second full copy of the store; our blobs live inside
   RocksDB (ADR-046), so that is the whole mail volume. The source must run exactly **0.16.27**
   (earlier 0.16 releases are upgraded first), and the target must be a new, empty store.
4. **The tool is young.** 1.0.0 → 1.0.4 in four days (2026-10-26 → 10-29). 1.0.4 fixed accounts
   without a ChangeId counter being skipped *silently* by `run`, `run --final`, `verify` and
   `rollback` (its CHANGELOG).
5. **Rollback after cutover loses data.** `rollback` copies a v1 store into a new, empty 0.16
   store; *(reported)* the queue and telemetry stay with v1 and v1-only data is dropped. Reverting
   the image pin alone does not work — 0.16 refuses a v1 store. Before v1 has served users,
   rollback is restarting 0.16 on the untouched old store.
6. **Settings the platform writes were renamed or removed** (stalwart-migrate `SCHEMA_CHANGES.md`):

   | v0.16 | v1 | Written by |
   |---|---|---|
   | `Bootstrap.serverHostname` | `defaultHostname` | Stalwart bootstrap job + plan template, mail-admin, email-ssl-status |
   | `NetworkListener.tlsImplicit` | `implicitTls` | `stalwart-domain-reconciler.ts`, `bootstrap.sh` |
   | `Imap.maxConcurrent` | `maxConcurrentConnections` | `imap-concurrency.ts`, `bootstrap.sh` |
   | `DnsResolver.concurrency` | `maxConcurrentRequests` | `dns-resolver-reconciler.ts` |
   | `ReportSettings.inboundReportMaxSize` (Integer) | `maxInboundReportSize` (Size) | `report-intake-reconciler.ts` |
   | `DmarcReportSettings.aggregateMaxReportSize` | `maxAggregateReportSize` | `dmarc-report-sender.ts` |
   | `DmarcReportSettings.aggregateSubject` | removed (not configurable) | `dmarc-report-sender.ts` |
   | `DmarcReport.dateRangeBegin` | `dateRangeStart` | `dmarc.ts` (read) |

   Several calls write a whole settings group at once, so one unknown field fails the entire
   write. Installs upgrade at their own pace, so the code must speak both versions until 0.16 is
   gone.
7. **Defaults that matter here** *(reported)*: much larger in-process caches (messages
   50 → 320 MB plus two new 512 MB tiers; events 10 → 48 MB) against a 2 GiB container limit that
   was raised twice after OOM kills; RocksDB `blobSize` 16834 → 4096 and `cacheSize` 128 MiB →
   engine default (the basis of ADR-046); the default in-memory store becomes process-local;
   jemalloc replaces glibc malloc (our `MALLOC_ARENA_MAX` tuning becomes moot); metric names
   become `stalwart_*` with unit suffixes (the admin mail summary reads them). *Measured on DEV
   (2026-10-31):* v1 on RocksDB held 1.56 GiB resident at 4.4 GB of mail, against 1.15 GiB for 0.16,
   with a working set of 1.97 GiB; on PostgreSQL, Stalwart itself stays at 0.1–0.4 GiB.
8. **What users notice** *(reported)*: OAuth tokens are not migrated — everyone signed in through
   single sign-on, or with a password and a second factor, signs in again; DAV clients re-sync
   once; full-text search is incomplete until the index is rebuilt (measured: 83–102 s per 4.6 GB on
   DEV). Bulwark ≥ 1.18.0 works with
   both versions and needs its *Auto-configure OAuth* step after the switch (Bulwark 1.18.0
   release notes).
9. **Backups and the standby are version-bound.** Every existing mailbox backup snapshot and the
   standby copy are in 0.16 format; v1 cannot boot from them.
10. **CPU and licence.** x86-64-v2 floor unchanged (`.cargo/config.toml` at both tags); aarch64 C++
    code now built with `-march=armv8-a+crc+crypto` *(inferred: excludes ARM cores without the
    crypto extensions)*. Licence unchanged (AGPL-3.0 / SELv2).

## Decision

1. **Hold 0.16** (`watch.hold: below 1.0`) until every condition below holds.
2. **The migration is a guided, operator-started action with a maintenance window** — not part of
   an automatic platform upgrade. *(Decided by the operator, 2026-10-30.)* It runs: a disk
   preflight for a second store copy; the platform's own answers for `prepare` that keep today's
   behaviour; repeated `run` while mail stays up; then the window — Stalwart at 0 replicas,
   `run --final`, `verify`, switch to v1, health checks, Bulwark OAuth registration; the 0.16
   store kept until the operator confirms.
3. **Groundwork first, safe on 0.16:** version-aware writes for every setting in Finding 6;
   backups and the standby tagged with the store's schema version, and a cross-version restore
   refused with an `OperatorError` instead of a crash loop; cache sizes pinned explicitly;
   metric names read for both versions.
4. **It ships in its own release** with a `### BREAKING` section describing the window and the
   re-sign-in.
5. **The deployment shape is decided before the migration is built** — moving to v1 already
   copies every byte, so it is the cheapest moment to change the store engine. Proposed: option B
   below (PostgreSQL data store on a dedicated CNPG cluster, message bodies and attachments as
   files on a volume, one Stalwart pod), with multi-node (option C) as a later opt-in. *(The
   operator decides after the store evaluation — it depends on the load-test results, the database
   sizes, and where message bodies and attachments live (operator, 2026-10-30). The evaluation ran
   on 2026-10-31; its results and recommendation are in* Store evaluation *below. Open.)*
6. **The v1 integration is built for v1, not ported field by field** — see *v1 capabilities to
   adopt from the start*.

## Conditions to lift the hold

- `stalwart-migrate` has gone at least two weeks without a data-loss or skipped-data fix.
- v1 is past its 14-day major-version soak (component watch).
- The groundwork (Decision 3) is merged and running on 0.16.
- A drill on DEV and on staging with a production-sized store passes: migration, measured window,
  per-mailbox backup and restore, standby, both webmail engines, rollback before and after cutover.
- The deployment-shape decision is recorded here, and its gates are met.

## Consequences

- Mail stays on a supported 0.16 until mid-2027 at the latest; the platform carries the
  version-aware code for both versions for at least one release cycle.
- Each install gets one maintenance window and one round of re-sign-in.
- The ledger keeps 0.16-only image findings (e.g. the brotli CVE waived for the Stalwart image)
  until the move.

## Deployment shape and store engines

Upstream: `stalw.art/docs` (cluster/*, storage/*, install/store), `stalwart-migrate` README.

- **A cluster needs shared stores.** RocksDB and SQLite are single-process; a multi-node Stalwart
  needs a PostgreSQL, MySQL or FoundationDB data store, a shared blob store (S3, Azure, a database,
  or `Default` = inside the shared data store), a shared search store (`Default`, Elasticsearch or
  Meilisearch), a Redis-family in-memory store (Redis, Valkey, Cluster or Sentinel) and a
  coordinator (the official image ships Redis-family and NATS). Each node leases a node id; the
  upstream Kubernetes chart is a StatefulSet.
- **Active-active works and is AGPL.** Any node serves any account over any protocol with no
  session affinity; the SMTP queue is shared (per-message locks), IDLE/push crosses nodes through
  the coordinator, ACME challenge proofs live in the in-memory store. Enterprise-only (SEL): SQL
  read replicas, sharded stores, tenant membership (`memberTenantId`), stored `Metric`s.
- **PostgreSQL is a production data store upstream** ("single nodes and clusters"; their sizing
  page benchmarks three nodes on one PostgreSQL plus Redis). Known limits: full-text indexing caps a
  field at 250k characters and stems only languages whose text-search config is installed; Stalwart
  never vacuums, so the blob table shrinks only with `VACUUM FULL` / `pg_repack`; a 16–32
  connection pool per node; and, measured here, full-text search that reads a whole large account
  while the GIN pending lists are full (*Store evaluation*, finding 1).
- **The migration can change the engine in the same step**: the tool reads and writes RocksDB,
  SQLite, PostgreSQL, MySQL and FoundationDB and "the source and target may use different data
  store backends". Blobs stored inside the source data store go into the target data store. Doing it
  later, within v1, is an offline `--export`/`--import` with the server stopped throughout.
- **Backups change character.** Upstream calls a file-level copy of a *running* RocksDB directory
  inconsistent — which is what today's live standby and store-level backups copy. On PostgreSQL,
  CNPG base backups with WAL (point-in-time recovery) and streaming replicas take that role; the
  per-mailbox JMAP/restic backups (ADR-048/061) are protocol-level and unaffected *(inferred)*.

| Option | Requires | HA | Risk |
|---|---|---|---|
| **A** v1, one pod, RocksDB | RocksDB→RocksDB copy; keep the standby and store backups | active-passive standby | least change now; a later cluster needs a full offline export/import |
| **B** v1, one pod, PostgreSQL on a **dedicated** CNPG cluster, search `Default`, blobs in the data store or as files on a volume (recommended) | a second CNPG `Cluster` (not `system-db`: its connection budget and volume are sized for the platform), a database owned by the stalwart role | the pod reschedules anywhere; data HA through CNPG failover when it runs ≥ 2 instances | the search plan on large mailboxes (*Store evaluation*, finding 1); with blobs inside, every CNPG instance, base backup and WAL archive carries all mail bytes; with blobs as files, a second volume backed up in step with the database; standby/DR modules rewritten |
| **C** B + several Stalwart pods + Valkey (Sentinel) as in-memory store and coordinator | B, Valkey (the dormant `k8s/base/valkey/` has Sentinel), HAProxy to every pod | active-active | most moving parts; changes mail port exposure (CLAUDE.md rule 4) |
| **D** FoundationDB | a self-built image (no official one), an FDB cluster of ≥ 3 nodes | self-replicating | an image we would build and sign; impossible on one-server installs |

**Proposed: B in the v1 migration, C later as an opt-in** — B→C needs no data-store migration (set
the in-memory store and coordinator, then scale); blobs kept as files move to S3 first. B keeps the
official image and AGPL, needs no S3 and runs unchanged on a one-server install (one CNPG instance,
one pod). Design point: on an install with more than one server, the mail database runs ≥ 2
instances even with HA mode off, or B loses today's standby fast path *(inferred)*.

**Gates before B is accepted:** ~~a PostgreSQL stress test on the same corpus as ADR-046's RocksDB
evaluation (ingest rate, FETCH latency, database and WAL growth, vacuum behaviour)~~ — done on DEV
(2026-10-31, *Store evaluation*), which adds four gates of its own; a timed
migration of a production-sized copy into PostgreSQL; ADR-030's swap triggers re-read for a second
settings-schema break and private upstream test suites.

## Store evaluation

The evidence for the deployment shape (Decision 5) and for where message bodies and attachments live.
Harness: `scripts/stalwart-loadtest/` (`lt.sh`, `loadgen.py`, `report.py`), run on DEV in a throwaway
namespace with production's Stalwart limits (1 CPU, 2 GiB) and launcher.

- **Corpus:** deterministic, identical for every variant — 50 mailboxes × 600 messages plus one
  mailbox of 25,000 (≈ 55,000 messages, 4.4 GB; mean 78 KB, median 7.7 KB; 20 % with an attachment of
  median 150 KB, base64 of random bytes). Production for scale (2026-10-31): 145 mailboxes, 45.6 GB by
  quota accounting, largest 13.9 GB, 11 over 1 GB — DEV holds about a tenth of it, so the results are
  per-GB figures to extrapolate, and the production-sized drill stays a staging condition.
- **Variants:** 0.16.27 on RocksDB (today); v1 on RocksDB; v1 on PostgreSQL (dedicated CNPG, PG 18,
  1 CPU / 2 GiB) with blobs in PostgreSQL, on a FileSystem volume, in an on-cluster S3, in an S3 on
  another machine; with FS blobs and the index in Meilisearch; a two-node v1 cluster on
  PostgreSQL + Valkey.
- **Measured per variant:** ingest by IMAP APPEND and by SMTP (incl. queue and spam filter), IMAP and
  JMAP read mixes, large-mailbox operations warm and after a restart, a mixed load, CPU-seconds and
  peak memory per phase, store size per GB of mail and WAL written, the cost of a full copy (tar /
  `pg_basebackup`), restart time, and the space after deleting half of every mailbox (purge,
  autovacuum, `VACUUM`, re-ingest, `VACUUM FULL`).
- **Migration:** `stalwart-migrate` from the loaded 0.16 store to v1 RocksDB and to v1 PostgreSQL —
  a live copy under load, a delta, the final run, `verify --full`, v1 start, a UID/body-hash sample
  comparison, the search-index rebuild, and a rollback after v1 has served mail.

The test lifts Stalwart's per-account request limits and inbound throttles, which would otherwise
measure themselves. Their defaults are what real clients meet, and the platform sets none of them:
HTTP (JMAP) 1,000 requests/min per account, anonymous HTTP 100/min per IP, IMAP 2,000 requests/min
per account; SMTP 5 messages/s per sender IP and **25/hour per sender domain and recipient**. The rate
limits are keyed on the account a token belongs to, so Bulwark's master-user impersonation does not
pool its users into one budget *(from source, v1.0.1)*.

**Migration mechanics, confirmed at small scale (Docker, 2026-10-31):** `prepare` runs unattended
when every question takes its recommended answer (four questions on a platform-shaped store:
categories, changed defaults, OAuth client registration, new permissions; 48 dropped role
permissions and OIDC-provider fields reported as warnings); the live copy reads the 0.16 store from a
**read-only** mount; `run --final` spends a fixed 30 s watching the source change counters before it
copies; `verify --full` found no mismatch; v1 started on the copy with UIDVALIDITY, UIDs, counts and
body hashes unchanged.

### Results (DEV, 2026-10-31)

Run `r1031` (4 h 48 min) and a follow-up `r1031b` (Meilisearch, a gentler copy, the failover) on
the single-node DEV cluster (6 vCPU, 12 GB, `local-path` on NVMe), next to DEV's own platform
(~1.3 cores). Stalwart 1 CPU / 2 GiB, PostgreSQL 18.6 1 CPU / 2 GiB; S3 remote =
versitygw on another lab VM. Every phase ran with 0 errors except where noted. The full tables
(`report.py`) and the 2,044 logged slow statements with their plans are kept with the run.

| | 0.16 RocksDB | v1 RocksDB | v1 PG, blobs in PG | v1 PG, blobs on FS | v1 PG, blobs in remote S3 |
|---|---:|---:|---:|---:|---:|
| IMAP APPEND, msg/s (Stalwart + store CPU-s per 1k) | 126 (7.9) | 315 (3.2) | 258 (5.0) | 381 (4.0) | 318 (4.7†) |
| SMTP delivery incl. spam filter, msg/s stored | 35 | 120 | 201 | 303 | 225 |
| IMAP reads, ops/s (bound by logins: ≈ 400 ms of password hashing each) | 324 | 768 | 799 | 791 | 733 |
| JMAP reads, ops/s | 456 | 2,867‡ | 1,572 | 1,749 | 281§ |
| JMAP CPU per op, Stalwart + store (ms) | 2.4 | 0.3 | 0.9 | 0.8 | 4.4§ |
| `FETCH 1:* (FLAGS)` over 17,500 messages | 1.3–1.6 s | 55 ms | 55–65 ms | 56 ms | 58–61 ms |
| mixed load p95: SMTP / IMAP fetch / JMAP search (ms) | 923 / 85 / 79 | 96 / 60 / 56 | 117 / 55 / 102 | 90 / 47 / 96 | 120 / 56 / 155 |
| peak memory, Stalwart RSS / working set (GiB) | 1.15 / 1.29 | 1.56 / 1.97 | 0.42 / 0.42 | 0.19 / 1.98¶ | 0.14 / 0.16 |
| peak memory, PostgreSQL working set (GiB) | – | – | 1.79 | 0.98 | 0.94 |
| store size ÷ raw mail | 1.0 | 1.1 | 1.1 | 1.1 | 1.1 |
| PostgreSQL database per GB of mail | – | – | 1.15 GB | 0.17 GB | 0.17 GB |
| WAL written per GB ingested | – | – | 1.9 GB | 0.5 GB | 0.5 GB |

† the remote S3's own CPU is not counted. ‡ the load generator (one Python process) was at a full
core, so this is a floor. § a planner effect, not the S3 (finding 1 below); the on-cluster S3 variant
read at 1,642 ops/s. ¶ page cache of the blob files, reclaimable, but counted against the
container limit. The on-cluster S3 (`rclone serve s3`) is left out of the table: it cost more CPU
than the mail server (156 msg/s, 10.4 CPU-s per 1k) and stands for no deployment.

**v1 against 0.16 on the same store and limits:** 2.5× the APPEND rate at 40 % of the CPU, 3.4× the
SMTP rate, 2.4× IMAP and ≥ 6× JMAP reads, SMTP p95 under mixed load 923 → 96 ms, a full-mailbox flag
fetch 24× faster — and 35 % more resident memory on RocksDB (1.56 against 1.15 GiB at 4.4 GB of
mail, a working set of 1.97 GiB against the 2 GiB limit: the larger caches of finding 7, now
measured). On PostgreSQL, Stalwart itself stays at 0.1–0.4 GiB and PostgreSQL holds the cache.

**Migration (`stalwart-migrate` 1.0.4, 4.6 GB / 55,000 messages / 52 accounts):**

| step | → v1 RocksDB | → v1 PostgreSQL (blobs in PG) |
|---|---:|---:|
| live copy while 0.16 serves | 50 s (≈ 97 MB/s) | 142 s (≈ 36 MB/s) |
| clients' throughput during the live copy | 56 % | 80 % |
| delta run | 7 s | 4 s |
| window: 0.16 stopped → `run --final` → `verify --full` → v1 ready | 73 s (38 + 9 + start) | 114 s (56 + 45 + start) |
| search index rebuilt after the switch | 83 s | 102 s |
| rollback after v1 took 300 new messages | 85 s, then 0.16 served the same mail | – |
| WAL written by the copy | – | 7.2 GB (1.4 × the data) |

`verify --full` found 0 mismatches and a UID/body-hash sample of 1,040 messages matched after every
switch and after the rollback. The live copy took 1.2–1.4 cores and ≤ 1.6 GiB, and slowed clients
through the shared disk, not the CPU (the node used 2.8 of 6 cores; Stalwart fell from 1.0 to 0.6
cores). `stalwart-migrate` rate-limits record reads (`--max-ops-per-sec`) but not blobs, which only
`--blob-concurrency` bounds (default: the write slots, at least 16). A second PostgreSQL migration
with `--concurrency 2 --blob-concurrency 2` took the same time (137 s — PostgreSQL's CPU sets the
pace) and kept clients at 87 % instead of 80 %; into RocksDB, where the disk sets the pace, the
knob should matter more (not measured). Its window was 110 s, `verify --full` again clean.

**Two-node cluster** (PostgreSQL + Valkey, both pods active): IDLE notifications crossed nodes in
5–6 ms p50 / 46 ms p95, 40 of 40; IMAP 1,308 and JMAP 1,687 ops/s on two 1-CPU pods against one
PostgreSQL CPU. With one pod deleted 30 s into a 20,000-message SMTP ingest, all 19,995 accepted
messages were stored; the other 5 got `421 4.3.0 Server shutting down` (a temporary failure that
senders retry) and 4 sessions were cut.

**Findings that shape the design:**

1. **Full-text search on PostgreSQL degrades on large mailboxes while the GIN pending lists are
   full.** In both migrated stores and two of seven ingested ones, JMAP text search took ~100 ms p50
   / 1.7–2.0 s p95, PostgreSQL sat at its CPU limit and every other request queued (254–281 reads/s
   against ~1,600). All 2,036 statements logged over 1 s were searches in the 26,099-message
   mailbox: v1 ORs `@@` over seven tsvector columns, each tsquery in a sub-select, and PostgreSQL
   read the whole account through the primary key and evaluated the seven matches per row. The
   cause, isolated on a fresh store: right after the ingest each GIN index held ≈ 7,100 entries in
   its fast-update pending list, and the planner chose the account scan — 645 ms for one search, 257
   reads/s; a plain `VACUUM` (which merges the pending lists) turned the same query into a BitmapOr
   over the GIN indexes — 1.35 ms, 1,282 reads/s, search p95 49 ms. `ANALYZE` alone changed nothing
   (migrated store: 268 → 272 reads/s). The fast runs are the ones autovacuum had vacuumed before
   the reads *(inferred for the earlier runs)*; in steady state new mail refills the lists up to
   `gin_pending_list_limit` (4 MB per index) between vacuums, so large mailboxes can flip back.
   Production's largest mailbox is 13.9 GB. Switching the pending lists off (`fastupdate = off` on
   the eight GIN indexes) is no fix: ingest fell from 248 to 174 msg/s, the index queue fell behind
   (34,400 of 55,000 messages indexed when the ingest ended), and with empty lists the planner still
   took the account scan until an `ANALYZE` (on a partly indexed table, so weaker evidence) — the
   plan depends on the pending lists and on fresh statistics. What holds: a `VACUUM (ANALYZE)` of
   the search tables as a cutover step after the index rebuild, and an autovacuum on them aggressive
   enough to keep the lists short (per-table insert thresholds, a smaller `gin_pending_list_limit`)
   — to be proven on staging with production-sized mailboxes. The query shape (a filter evaluated
   per row of a large account whenever the GIN path looks dearer) is upstream's to fix; worth
   reporting. Diagnostic: `scripts/stalwart-loadtest/pgplan.sh`.
2. **Deleted mail keeps its disk space — for 180 days.** v1 links the body of every unencrypted
   message appended to INBOX over IMAP or JMAP to a spam-classifier training sample, and so for mail
   a user marks Junk / not Junk, replies to sent mail, mail from address-book senders and spam with
   ≥ 2 RBL hits. The sample keeps the blob for `SpamClassifier.holdSamplesFor`, **180 days** by
   default, and deleting the message leaves the sample. The corpus made 47,500 samples (exactly its
   INBOX appends); deleting half of every mailbox and purging freed nothing in any v1 variant. For a
   tenant this is also a data-protection matter: mail they deleted stays on disk, and in every
   store-level backup, for half a year. Destroying the samples (`x:SpamTrainingSample`) and purging
   freed the blobs; a shorter hold takes effect for new samples after a restart (both checked in
   Docker). IMAP migrations (imapsync) and mailbox restores are appends, so they create samples in
   bulk. SMTP deliveries do not, except for the cases above.
3. **Freeing space after a deletion is a sequence.** The index queue processes the deletion (8,750
   in < 30 s), a per-account purge drops the message and its blob link (46 tasks, 5 minutes), and
   only then can a blob purge delete the blob; the scheduled blob clean-up runs daily at 04:00
   (`DataRetention.blobCleanupSchedule`). The index queue is the search store's queue: with the index
   in a Meilisearch that lagged behind, 1,272 deletions were still queued when the samples were
   released, and only a third of the deleted mail's blobs came free. On PostgreSQL the database
   file then shrinks only with `VACUUM FULL` / `pg_repack` (as reported); RocksDB compacts on its
   own (5.30 → 5.06 GB while 0.6 GB of new mail arrived).
4. **Meilisearch as the search store is not a fit at this budget.** With v1 on PostgreSQL and FS
   blobs, moving the index to Meilisearch (v1.56, 1 CPU / 2 GiB on top) gave the fastest ingest (433
   APPEND / 327 SMTP msg/s) and fast queries — but Meilisearch indexed ≈ 14 messages/s at its CPU
   and memory limits, so 25 minutes after the ingest it held 21,284 of ~60,000 messages and every
   search in the large mailbox found nothing; its index, holding part of the mail, was already 0.96
   GB against ≈ 0.53 GB for PostgreSQL's index of all of it. At that rate a migration's rebuild of
   production's index takes on the order of half a day. v1 also creates the Meilisearch indexes with
   typo tolerance on, so a search for a token returns every token one letter off (`zq197x`: 1 exact
   match and 22 neighbours — an invoice number would list its neighbours); switching it off per
   index restores exact matches and survives restarts (Docker).
5. **WAL is the hidden size of blobs-in-PostgreSQL.** Every mail byte goes through WAL (1.9× on
   ingest, 1.4× on the migration copy) — into archived WAL in the backup target and onto every
   replica. With blobs outside, WAL is 0.5× and the database a sixth of the mail. `pg_wal` itself
   holds up to `max_wal_size` (4 GB here) even when idle.
6. **Base backups: copy fast, start slow.** `pg_basebackup` copied 830 MB in 2.6–3.4 s with a fast
   checkpoint (5.9 GB in 11 s for a migrated store with every mail byte inside), and took
   453–504 s with the default spread checkpoint, which paces itself over
   `checkpoint_completion_target × checkpoint_timeout` before copying. CNPG's backups default to the
   spread form (`immediateCheckpoint: false`).

**At production's size** (45.6 GB, 145 mailboxes; DEV disk speeds, so a lower bound for a VPS):
any engine stores ≈ 50 GB; with blobs in PostgreSQL the database is ≈ 52 GB plus `pg_wal`, and every
CNPG instance and base backup carries it; with blobs on a volume or in S3 the database is ≈ 8 GB. The
live copy takes ≈ 8 min to RocksDB and ≈ 21 min to PostgreSQL (one PostgreSQL CPU); the window is
≈ 3 min (RocksDB) to ≈ 10 min (PostgreSQL, mostly `verify --full`), and search is incomplete for
another ≈ 14–17 min. A migration into PostgreSQL writes ≈ 65 GB of WAL. These are linear
extrapolations; the staging drill with a production-sized copy remains a condition.

**Recommendation for Decision 5** (the operator decides): **option B with message bodies and
attachments as files** — one v1 pod; data and search index in PostgreSQL on a dedicated CNPG
cluster; blobs on their own volume next to the pod.

- It was the fastest shape (381 APPEND / 303 SMTP msg/s, mixed-load p95 90 / 47 / 96 ms) at
  0.8 ms of CPU per JMAP read.
- It keeps the database at a sixth of the mail (≈ 8 GB for production), so CNPG base backups take
  seconds, WAL is 0.5× the mail and PostgreSQL stays near 1 GiB.
- Bodies become immutable, content-addressed files that the existing restic tooling backs up
  incrementally.
- Stalwart itself needs ≈ 0.2 GiB; the blob files' page cache counts against its limit but is
  reclaimable.

The cost: the blob volume is single-writer, so a later multi-node step (C) moves the blobs to S3,
and a restore must pair a database point with a blob snapshot no older than it — a blob missing
from the snapshot is lost mail, an extra blob is only purged.

- **Blobs in PostgreSQL** (B as first proposed) is the simplest store — one engine, CNPG HA covers
  everything — but at production's size the database is ≈ 52 GB. That carries into every replica,
  base backup and WAL archive: 1.9× on ingest and ≈ 65 GB during the migration. PostgreSQL also
  reached 1.79 of its 2 GiB. It suits small installs.
- **Blobs in S3** is the multi-node path (C): close to file speed with a real S3 (318 / 225 msg/s),
  but it needs an S3 service on every install. It belongs to the opt-in.
- **A (v1 on RocksDB)** had the fastest JMAP reads, no search-plan risk and the shortest window
  (73 s). But its memory grows with the store (1.56 GiB resident at 4.4 GB of mail), so cache caps
  are mandatory. It keeps the file-level copies of a running RocksDB that upstream calls
  inconsistent, and a later move to PostgreSQL is a full offline export/import.
- **Search** stays in PostgreSQL (`Default`). Meilisearch is not worth a second stateful service at
  this budget (finding 4).

Gates added for B by the evaluation:

1. The search-plan mitigation (finding 1), proven on staging with production-sized mailboxes.
2. A decided `holdSamplesFor` and a way to release the samples of deleted mail (finding 2).
3. A backup and standby design that pairs CNPG points with blob snapshots.
4. The staging drill with a production-sized copy, timed.

## v1 capabilities to adopt from the start

The management API keeps its v0.16 shape (the JMAP `x:` registry); the work is the schema and the
behaviour behind it. Adopt with the migration:

- **Explicit memory budget and cache sizes** (`SystemSettings.maxBufferedMemory`, `Cache.*`): the
  upstream defaults add up to more than a 2 GiB container *(reported)*; on RocksDB v1 was at
  1.56 GiB resident with a tenth of production's mail (measured).
- **The spam classifier's sample hold** (`SpamClassifier.holdSamplesFor`, 180 days by default):
  a value chosen deliberately, applied with a restart, and the samples of mail a tenant deletes —
  and of bulk imports and restores into INBOX — released (`x:SpamTrainingSample`), or deleted
  mail stays on disk and in backups for half a year (*Store evaluation*, finding 2).
- **The new task model** (Retry → Stalled → Failed, no update/destroy while a task runs): the ACME
  renewal clean-up in `stalwart-domain-reconciler.ts` relies on destroying a running task, which v1
  refuses; Stalled/Failed tasks belong in mail health.
- **Search index queue and limits** (`x:IndexQueueStatus`, `Search.maxExtract*`,
  `maxConcurrentIndexTasks`): the index is rebuilt after cutover — a cutover and health signal, and
  limits for small nodes. On PostgreSQL the cutover ends with `VACUUM (ANALYZE)` of the search
  tables, and their autovacuum is tuned so the GIN pending lists stay short (finding 1).
- **The new metrics** (`stalwart_*` with unit suffixes, OpenMetrics): rewrite the mail summary's
  parser; consider scraping Stalwart from VictoriaMetrics directly.
- **`Http.clientIpSource` + `forwardedHops`:** browser JMAP reaches Stalwart through Traefik, so
  HTTP auth-failure bans and rate limits otherwise key on the Traefik pod *(inferred)*.
- **`ReloadSettings` warnings** reported to drift/health instead of ignored.
- **DKIM `Manual` at domain creation** (v1 defaults to `Automatic`, Ed25519 + RSA, rotating only when
  Stalwart owns DNS — the platform owns DNS and rotates RSA A/B selectors, ADR-047).
- **One `outboundReportDomain`** for every report type, replacing per-report sender settings.
- **Per-message limits** (`maxFlagsPerEmail`, `maxMailboxesPerEmail`, `maxHeaderSize`): exercise
  restore and imapsync against them.
- **OAuth for mail clients:** the operator prefers to expose it; the impact is in *OAuth for mail
  clients* below. ~~v1 advertises OAuth through client autoconfiguration while the endpoints sit
  behind the admin gate *(inferred conflict)*~~ — not a conflict (2026-10-31): mail clients get the
  platform's own autoconfig and autodiscover, which offer passwords only; v1's PACC document (with
  its `oauth-public` profile) is not routed to clients.
- **Rebuild rather than port:** drop the legacy `Principal/*` translation in `stalwart-jmap/client.ts`
  and talk to `x:Account` / `x:Domain` directly, checked against the server's `/api/schema/{hash}`;
  a v1 path for `bootstrap.sh` and the bootstrap plan; a least-privilege `ApiKey` for platform-api
  instead of the admin password; log levels re-chosen (delivery progress moved to debug); webhook
  events subscribed by name (ids were renumbered).
- **Later:** first-party OAuth for Bulwark (replacing master-user impersonation), connected-apps
  listing in the tenant panel, JMAP/IMAP METADATA, cache swap to disk.
- **No:** DKIM2 (draft), letting Stalwart rotate DKIM, Enterprise-only features (multi-tenancy
  objects, per-domain directories, SCIM, masked email, restoring deleted accounts, the AI spam
  classifier, stored metrics) — tenant isolation stays in the platform. Removed and written by us:
  `DmarcReportSettings.aggregateSubject`. Pyzor's default flips to off (`prepare` asks).

Upstream test suites became private on 2026-10-16; our integration harness is the only test
evidence for each Stalwart bump from here on.

## Open decisions (operator)

- ~~Migration trigger~~ — decided 2026-10-30: an operator-started action with a window.
- Deployment shape: the store evaluation (2026-10-31) recommends B with message bodies and
  attachments as files, search in PostgreSQL; the operator decides (A, B with blobs inside, or
  straight to C are the alternatives it compares).
- OAuth for mail clients: the operator prefers exposing it (2026-10-30), subject to the impact below.
  What remains to decide is the coupling: a login-password revoke also revokes the mailbox's OAuth
  grants (recommended), and whether the tenant panel lists connected applications.

## OAuth for mail clients

Verified on v1.0.1 with `scripts/stalwart-loadtest/oauth-probe.py` (2026-10-31): a login password
issued the way `login-passwords/service.ts` does it, a public client registered over RFC 7591,
authorization code with PKCE, then the token over JMAP and IMAP.

- **No tenant-panel account is needed.** The sign-in page is Stalwart's own, and it accepts the
  mailbox address and a **login password** (`authenticate_login` → `authenticate_basic`, which takes
  app passwords). Nobody needs the hidden primary password (ADR-049), so the credential model stays
  as it is: the tenant admin issues a login password, the user signs in once with it, the device then
  holds a token instead of the password. The token works for JMAP (Bearer) and IMAP
  (`AUTH=XOAUTH2`/`OAUTHBEARER`, both advertised next to `PLAIN` after STARTTLS).
- **An OAuth session outlives the login password it was opened with.** After the login password was
  revoked, Basic auth with it failed (401), but the access token kept working for JMAP and IMAP, and
  the refresh token kept issuing new ones. A grant records the account, client, scopes and IP — not
  the credential (`NewOAuthGrant`); its tokens are bound to a hash of the *primary* password
  (`credential_version`). A login password's expiry and IP allow-list therefore do not limit the
  session either. Destroying the grant (`x:OAuthGrant`, "connected applications") cut access
  immediately and the refresh was refused. Re-randomising the primary password would end every
  session of the mailbox at once *(from source: `assert_credential_version`)*.
- **Lifetimes** (v1 defaults): access token 1 h, refresh token 30 days and renewed on use — a client
  that syncs monthly never signs in again.
- **Second factor:** login passwords skip TOTP, so a sign-in with one is single-factor — the same as
  an IMAP login with it today. No change, no gain.
- **Registration:** v1 always accepts anonymous RFC 7591 registration of public clients, under the
  anonymous HTTP rate limit (100 requests/min per IP by default); dynamically registered clients must
  declare their scopes and may not use the device-code grant.
- **Exposure:** `/auth/*`, `/api/auth`, `/.well-known/oauth-authorization-server`,
  `/.well-known/openid-configuration` and the sign-in web UI must be reachable on the mail hostname
  over HTTPS, outside the admin gate — an internet-facing login form behind the WAF and Stalwart's
  `authBanRate`.

**What exposing it requires from the platform:** a login-password revoke that also destroys the
mailbox's grants (all of them — a grant does not say which credential opened it); grants destroyed on
mailbox suspend and delete; optionally a per-mailbox list of connected applications in the tenant
panel (client name, created, last used, IP — all in `x:OAuthGrant`); an OAuth entry in the
autoconfig/autodiscover templates once the endpoints are public; the routes above with the WAF in
front. Bulwark's own OAuth (first-party, cluster-internal) is separate and needs none of this.

## Keeping this record current

This ADR is updated — with a line in the revision log and a new *Last reviewed* date — whenever:
a Stalwart or `stalwart-migrate` release appears in the weekly component-watch sweep (AGENTS.md
§ *Keeping components current*); a drill measures something listed as *(reported)*; a condition
above is met; or a decision is taken. A finding that stops being true is struck through with the
date, not deleted.

## Revision log

- 2026-10-30 — Created from the v1.0.1 / stalwart-migrate v1.0.4 assessment; added the deployment-shape
  and store-engine research (options A–D, proposed B) and the v1 capabilities to adopt.
- 2026-10-31 — Operator decisions recorded: the migration is operator-started; the deployment shape
  waits for the store evaluation; OAuth exposure preferred. OAuth impact verified on v1.0.1 (login
  passwords sign in; a session outlives its login password); the autoconfig "conflict" struck.
- 2026-10-31 — Store evaluation run on DEV (`r1031`, follow-up `r1031b`, plan experiments
  `r1031c`/`d`): results, six findings (search plan on PostgreSQL, 180-day spam-sample hold, the
  delete → purge sequence, Meilisearch, WAL volume, base-backup checkpoints), production
  extrapolation, and a recommendation for Decision 5 (B with blobs as files). Findings 7 and 8
  partly measured; option B's risks, gates and the open decision updated.
