# ADR-044: Per-tenant mailbox backup engine — JMAP to IMAP MULTIAPPEND

**Status**: **ACCEPTED 2026-05-22** — IMAP MULTIAPPEND is the default engine for `platform_settings.mailbox_backup_engine` on new clusters and (post-flip) on all existing clusters.

**Supersedes**: the JMAP-only path described in ADR-036 §4.2 (tenant-bundles `mailboxes` component).

**Related**: ADR-036 (tenant-backup restic-on-JMAP), ADR-040 (system tenant).

---

## TL;DR

Per-tenant mailbox capture + restore was JMAP-only since the 2026-05-11 ADR-036 rewrite. We switched to IMAP4rev2 + CONDSTORE + MULTIAPPEND because:

1. **Faster, both directions.** Same source mailbox (3000 msgs / 225.6 MB / 4 workers, instrumented `bench-imap-vs-jmap.sh`):
   * Capture: **IMAP 5.48 s (548 msg/s)** vs **JMAP 19.00 s (158 msg/s)** — IMAP 3.5× faster.
   * Restore: **IMAP 36.05 s (83 msg/s)** vs **JMAP 71.37 s (42 msg/s)** — IMAP 2.0× faster.
   * Byte-equal output (tarball gz + STATUS SIZE on dst both 225.6 MB).
2. **Correctness wins** the JMAP path had silently degraded on:
   * **UTF-8 folder names** — "Geschäftlich" was renamed to "Gesch_ftlich" on JMAP restore until the 2026-05-22 `.imap-name` sidecar fix was mirrored from the IMAP path. IMAP preserves byte-for-byte.
   * **Custom IMAP keywords** (`$Junk`, `$Forwarded`, etc.) — JMAP dropped them; IMAP preserves them via `.keywords` sidecars.
3. **Protocol simplicity.** `FETCH BODY.PEEK[]` streams raw RFC 822 with no JSON wrapping, no per-blob HTTP round-trip, no per-message `Email/get`+`Blob/get` choreography.

The trade-off — IMAP MULTIAPPEND uses ~5× more helper-pod memory during restore (153 MB vs 33 MB at K=4) — is well inside the 256 Mi default pod-memory limit. Operators should size mailbox-worker pods with `limits.memory: 512Mi` for headroom.

---

## Decision drivers

### 1. Real-world tenants accumulate enough mail to make the perf gap user-visible

Before the M14 catalog rewrite the median tenant had under 1 k messages and the JMAP path's ~40 msg/s restore was invisible. By 2026-Q1 several active tenants had crossed 10 k messages and DR-restore time was becoming an operator complaint. Measured on testing.phoenix-host.net (single-node, local-path storage, K=4 workers):

| Corpus | IMAP cap / restore | JMAP cap / restore | IMAP advantage |
|---|---|---|---|
| 3 k msgs (225 MB) | 5.5 s / 36 s | 19.0 s / 71 s | cap 3.5× / rest 2.0× |
| 10 k msgs (731 MB) | 16.6 s / 120 s | 85.2 s / 274 s | cap 5.1× / rest 2.3× |
| 50 k msgs (extrap) | ~83 s / ~10 min | ~7 min / ~23 min | widens |

**IMAP scales linearly** — restore msg/s is flat at ~83 across 3 k and 10 k (the per-msg Stalwart processing ceiling: FTS + threading + ACL); capture actually slightly *improved* from 548 → 601 msg/s at 10 k. **JMAP degrades** — capture msg/s dropped 158 → 117 (-26%) and restore 42 → 36.5 (-13%) from 3 k → 10 k, because the `Email/get` + `Blob/get` pipeline pays per-folder MailboxQuery overhead that amortises poorly with corpus size.

For tenants with active webmail users + IMAP mobile clients the restore window is downtime they can see. At 10 k messages IMAP cuts it from 4.5 min to 2 min; at 50 k from 23 min to 10 min.

### 2. JMAP correctness regressions were data-loss-class

The UTF-8 folder corruption is a *silent* restore bug — the user's "Geschäftlich" folder reappears as "Gesch_ftlich" with no error logged anywhere. Operators only noticed because a German tenant complained. The custom-keyword loss has the same shape: IMAP $Forwarded flag becomes plain $Seen after a JMAP round-trip. Both bugs are absent on the IMAP path.

We patched both in the JMAP path on 2026-05-22 (`.imap-name` + `.keywords` sidecar mirroring), but the patches are best-effort recovery — for snapshots taken *before* the fix shipped, the sidecar is absent and folder-name normalisation is irreversible.

### 3. Stalwart 0.16's IMAP4rev2 capability set is fully sufficient

Pre-auth `CAPABILITY` is deliberately minimal but the post-auth list includes everything needed for parallel bulk transfer:

```
IMAP4rev2 IMAP4rev1 ENABLE SASL-IR LITERAL+ ID UTF8=ACCEPT JMAPACCESS
IDLE NAMESPACE CHILDREN MULTIAPPEND BINARY UNSELECT ACL UIDPLUS
ESEARCH WITHIN SEARCHRES SORT THREAD=REFERENCES LIST-EXTENDED
LIST-STATUS ESORT SORT=DISPLAY SPECIAL-USE CREATE-SPECIAL-USE
MOVE CONDSTORE QRESYNC UNAUTHENTICATE STATUS=SIZE OBJECTID
PREVIEW RIGHTS=texk QUOTA QUOTA=RES-STORAGE
```

Key extensions that made the rewrite viable:
- **MULTIAPPEND** (RFC 3502) — N messages per round-trip, byte-budgeted batching up to 80 MiB per LITERAL+ batch.
- **LITERAL+** (RFC 7888) — non-synchronising literal, removes the 3-RTT-per-APPEND cost of vanilla IMAP.
- **CONDSTORE + QRESYNC** (RFC 7162) — server-side modseq for incremental sync via `FETCH CHANGEDSINCE`; standardised path versus JMAP `Email/changes`.
- **STATUS=SIZE** + **UIDPLUS** — capture+verify primitives we rely on.

### 4. Naive IMAP APPEND would be *slower* than JMAP — MULTIAPPEND is essential

A measurement trap: imaplib's `append()` doesn't use LITERAL+ and waits for `+ Ready` per message → 3 round-trips per APPEND. Vanilla APPEND is ~15 msg/s, slower than JMAP's ~20 msg/s. The decision relies on MULTIAPPEND batched at ~200 messages per round-trip; without it the rewrite is a regression.

### 5. Auth model unchanged

Both engines authenticate via Stalwart's master-user proxy (`<addr>%<master-fqdn>` with `STALWART_MASTER_PASSWORD`). Same secret (now `mail-secrets`, renamed from `roundcube-secrets` 2026-05-22), same rotation flow (rotate-jmap.ts → patch Secret → kubelet refresh).

A *separate* admin path bumps Stalwart's `x:Imap.maxConcurrent` transiently from 16 → 64 around each mailbox Job to admit four concurrent IMAP connections per user (Stalwart's effective per-user cap is approximately `maxConcurrent / 16`). The elevation uses admin credentials; LOGIN uses master. See `backend/src/modules/mail-admin/imap-concurrency.ts`.

---

## Implementation

| Component | Path | Notes |
|---|---|---|
| Engine selector | `backend/src/modules/tenant-bundles/mailbox-backup-engine.ts` | `platform_settings.mailbox_backup_engine` ∈ {`imap`, `jmap`}; default `'imap'` since 2026-05-22 |
| Admin UI | `frontend/admin-panel/src/components/mail-settings/MailboxBackupEngineSection.tsx` | `/settings/email` → Backup Engine tab |
| Capture script | `images/mail-backup-tools/imap-sync.py` | Folder enumeration → FETCH 1:* BODY.PEEK[] → Maildir output |
| Restore script | `images/mail-backup-tools/imap-restore.py` | `--workers N` (default 4) parallel pool; byte-budgeted MULTIAPPEND (REQUEST_CAP=100 MiB, LITERAL+ batch=80 MiB, MAX_BATCH=200) |
| Sidecar metadata | `.imap-name` + `.keywords` | UTF-8 folder names + custom IMAP flags; mirrored to JMAP path 2026-05-22 |
| Cluster gate | `backend/src/modules/tenant-bundles/cluster-concurrency.ts` (`mailbox-worker` slot) | Caps concurrent mailbox Jobs at 4 per cluster |
| IMAP-concurrency elevator | `backend/src/modules/mail-admin/imap-concurrency.ts` | Idempotent `x:Imap/set maxConcurrent=64` on slot acquire; 5-min reverter on idle |
| Legacy archive | `images/mail-backup-tools/legacy/jmap-sync.py` + `jmap-restore.py` | Kept on operator direction as don't-delete fallback |

---

## Considered and rejected

### Rejected: CLI `stalwart -e` / `-i`
Stalwart's whole-server export/import via CLI is the unmatched fast path (3175 msg/s export, ~30 s for 3 k messages). But it is **whole-server** and requires `kubectl scale stalwart-mail --replicas=0` plus a privileged pod — incompatible with per-tenant migration and live operation. Reserved for mass migration / disaster-recovery, not the per-tenant backup loop.

### Rejected: per-account JMAP CalDAV/CardDAV
The JMAP DAV extensions (`urn:ietf:params:jmap:contacts`, `:calendars`) exist as draft RFCs but Stalwart 0.16's implementation is incomplete. CardDAV/CalDAV backup is therefore a separate work-item (see §Open follow-ups) and will likely go through native DAV PROPFIND+REPORT rather than JMAP.

### Rejected: leaving `x:Imap.maxConcurrent` permanently at 64
Stalwart's per-user buffered-APPEND worst-case memory is `maxConcurrent × maxRequestSize` ≈ 6.4 GiB at maxConcurrent=64 + 100 MiB request cap. In practice no client triggers that, but the conservative default-16 ceiling is what upstream picked for memory hygiene. The elevator pattern keeps Stalwart at the default during idle periods and elevates only around active mailbox Jobs — a 5-min reverter scheduler reverts to 16 once `tenant_bundle_in_flight` empties.

### Rejected: bumping `x:Imap.maxConcurrent` via static config
The setting is mutable via JMAP `x:Imap/set` (live, no restart) and persists in Stalwart's DB. We use the live API. Static config writes would require a Stalwart pod recycle on every elevation, which is unacceptable mid-Job.

---

## Open follow-ups (not blocking ADR acceptance)

1. **Auxiliary mailbox data (Sieve / Contacts / Calendar / Vacation)** — currently NOT in tenant-bundles scope; loss on tenant-restore is real. 2026-05-22 capability probe confirmed Stalwart 0.16 advertises all four as JMAP capabilities:
   * `urn:ietf:params:jmap:sieve` (RFC 9404)
   * `urn:ietf:params:jmap:contacts` + `:contacts:parse` (RFC 9610)
   * `urn:ietf:params:jmap:calendars` + `:calendars:parse`
   * `urn:ietf:params:jmap:vacationresponse`
   * `urn:ietf:params:jmap:filenode` (file storage — out of scope for now)

   DAV endpoints `/dav/cal/`, `/dav/card/`, `/.well-known/{cal,card}dav` all return 401 (auth required) — confirming the surfaces are wired up. Implementation plan: add a `jmap-aux-sync.py` + `jmap-aux-restore.py` pair that runs alongside the existing mail capture, using the same JMAP master-proxy transport. Serialise to JSON sidecars under `<account>/.aux/{sieve,contacts,calendar,vacation}.json` inside the Maildir tarball. Per-account scope mirrors per-account mail backup cleanly; no new auth, no new ports, no DAV plumbing. Tracked as TASK #35 (sieve), #36 (contacts), #37 (calendar) — likely consolidated into one task `mailbox-aux-backup`.

2. **Scale validation beyond 50 k msgs** — 3 k and 10 k validated (TASK #34 complete; IMAP restore msg/s held flat at 83 across both, JMAP degraded modestly). The 50 k extrapolation in §1 is based on the linear curve through these two data points; whether RocksDB compaction or FTS index growth introduces a knee at 50 k+ is untested. Operators handling tenants with >50 k messages should run the bench against a representative corpus.

3. **Bytes-on-wire metric for IMAP** — `imaplib`'s buffered-read path bypasses the socket-hook in our instrumentation; tarball size is used as a proxy in the bench harness.

---

## Verification

- **17 unit tests** for the elevator (`backend/src/modules/mail-admin/imap-concurrency.test.ts`) — idempotency, race-recheck, JMAP method errors, fractional-floor defensive, DB-failure swallow. 17/17 pass.
- **30 mailbox-component + restore-executor tests** continue to pass.
- **L1 integration harness** (`scripts/integration-tenant-bundles-mailbox-engine.sh`) exercises both engines end-to-end at K=4 against a 3 k-message edge-case corpus (UTF-8 folder names, 60 MB attachment, custom keywords); 8/8 PASS with both engines.
- **Live bench** on testing.phoenix-host.net captured the numbers in §TL;DR.

---

## Auth invariant (do not break)

Every code path here must preserve:
- IMAP LOGIN → master account (`<addr>%<master-fqdn>` + `STALWART_MASTER_PASSWORD`)
- JMAP `x:Imap/set` → admin account (`admin` + `STALWART_ADMIN_PASSWORD`)

Conflating these silently degrades to a `NO Authentication failed` on Stalwart with no useful error context. The split is enforced in code via:
- `imap-sync.py` / `imap-restore.py` cmdline args (`--master-user`, `--auth-pass-env STALWART_MASTER_PASSWORD`)
- `imap-concurrency.ts:loadAdminAuthHeader` → `readStalwartCredentials(process.env)` → mounted `STALWART_ADMIN_CREDS_DIR/ADMIN_SECRET_PLAIN`

The two secrets are rotated independently; mixing the rotation paths would cascade.
