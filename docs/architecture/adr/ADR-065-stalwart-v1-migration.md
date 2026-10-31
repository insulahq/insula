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
   become `stalwart_*` with unit suffixes (the admin mail summary reads them).
8. **What users notice** *(reported)*: OAuth tokens are not migrated — everyone signed in through
   single sign-on, or with a password and a second factor, signs in again; DAV clients re-sync
   once; full-text search is incomplete until the index is rebuilt. Bulwark ≥ 1.18.0 works with
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
   below (PostgreSQL data store on a dedicated CNPG cluster, one Stalwart pod), with multi-node
   (option C) as a later opt-in. *(Open. The operator decides after the store evaluation: it depends
   on the load-test results, the database sizes, and where message bodies and attachments live —
   operator, 2026-10-30. See* Store evaluation *below.)*
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
  connection pool per node.
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
| **B** v1, one pod, PostgreSQL on a **dedicated** CNPG cluster, blobs and search `Default` | a second CNPG `Cluster` (not `system-db`: its connection budget and volume are sized for the platform), a database owned by the stalwart role | the pod reschedules anywhere; data HA through CNPG failover when it runs ≥ 2 instances | PostgreSQL performance at our scale unmeasured; full-text limits; every CNPG instance and base backup carries all mail bytes; standby/DR modules rewritten |
| **C** B + several Stalwart pods + Valkey (Sentinel) as in-memory store and coordinator | B, Valkey (the dormant `k8s/base/valkey/` has Sentinel), HAProxy to every pod | active-active | most moving parts; changes mail port exposure (CLAUDE.md rule 4) |
| **D** FoundationDB | a self-built image (no official one), an FDB cluster of ≥ 3 nodes | self-replicating | an image we would build and sign; impossible on one-server installs |

**Proposed: B in the v1 migration, C later as an opt-in** — B→C needs no data migration (set the
in-memory store and coordinator, then scale). B keeps the official image and AGPL, needs no S3 and
runs unchanged on a one-server install (one CNPG instance, one pod). Design point: on an install
with more than one server, the mail database runs ≥ 2 instances even with HA mode off, or B loses
today's standby fast path *(inferred)*.

**Gates before B is accepted:** a PostgreSQL stress test on the same corpus as ADR-046's RocksDB
evaluation (ingest rate, FETCH latency, database and WAL growth, vacuum behaviour); a timed
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
  another machine; a two-node v1 cluster on PostgreSQL + Valkey.
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

*Results: pending the DEV run.*

## v1 capabilities to adopt from the start

The management API keeps its v0.16 shape (the JMAP `x:` registry); the work is the schema and the
behaviour behind it. Adopt with the migration:

- **Explicit memory budget and cache sizes** (`SystemSettings.maxBufferedMemory`, `Cache.*`): the
  upstream defaults add up to more than a 2 GiB container *(reported)*.
- **The new task model** (Retry → Stalled → Failed, no update/destroy while a task runs): the ACME
  renewal clean-up in `stalwart-domain-reconciler.ts` relies on destroying a running task, which v1
  refuses; Stalled/Failed tasks belong in mail health.
- **Search index queue and limits** (`x:IndexQueueStatus`, `Search.maxExtract*`,
  `maxConcurrentIndexTasks`): the index is rebuilt after cutover — a cutover and health signal, and
  limits for small nodes.
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
- Deployment shape: after the store evaluation (option B recommended so far; A, or straight to C).
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
