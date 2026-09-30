# ADR-063 — Bundle re-import from an upload: re-ingest, don't re-register

**Status:** Proposed (2026-09-30)
**Related:** ADR-032 (bundle format + data export), ADR-034 (restore cart), ADR-061
(restic-native per-mailbox capture), ADR-060 (WAF body inspection), ADR-047 (cluster
concurrency gate). **Supersedes** the `reuseUuid / reuseNamespace` TODO noted in
`dr-recover/recreate.ts`.

## Context

An operator or tenant has an exported bundle as a file — downloaded from this platform or
carried from another region — and wants to (1) put it back into the platform and (2) restore
from it. Neither works today, and the reasons are separate.

### What already exists

- **Export streams properly.** `feedSourceIntoTar` opens a `restic dump` per component and
  re-tars it entry by entry. Nothing is buffered.
- **Import exists in three routes** — `import-preview` (512 MiB), `import`,
  `import-finalize` (2 GiB). All of them `part.toBuffer()` the whole archive into memory,
  hold **every extracted entry as a second Buffer** (4 GiB decompressed cap), and write each
  one as an **object artifact** plus a `backup_jobs` row.
- **Restore and browse are keyed on `backup_components.sha256` being a restic snapshot id**
  and run `restic restore <snap>` inside a Job.
- **A streaming ingest rail already exists.** `internal-upload-route.ts` accepts
  `POST /internal/bundles/:id/components/:comp/:artifact?token=<hmac>` and pipes
  `request.raw` **straight into `runResticBackup({ stdin })`** for `files`/`mailboxes`, or
  into `store.writeComponent` for `config`/`secrets`. No buffering, with abort handling,
  idle-socket timeouts, the cluster concurrency gate and failure notifications.
- **`dr-recover/recreate.ts` already registers `backup_components` rows from `meta.json`**,
  so the existing provision + restore-cart flow runs unchanged against a re-registered
  bundle.

### The three walls, in the order they are hit

**1. The WAF rejects the upload at 12.5 MiB.** `import-finalize`'s 2 GiB `bodyLimit` is
unreachable. Measured against the ingress:

```
POST 40 MiB multipart → http=413  uploaded=1,113,830  time=0.105 s
```

`waf-body-limit` (`maxRequestBodyBytes: 13107200`) applies to the import route — the same cap
that protects Traefik from the ModSecurity plugin's unbounded `io.ReadAll`. **Any bundle
import over ~12.5 MiB fails at the ingress today.** Note the cap is not method-scoped and
neither is the plugin: see D3 for why a `Method()` term is not a way around either.

**2. Memory.** Past the WAF, the archive lives in platform-api RAM twice — raw body plus
every extracted entry.

**3. The contract gap.** Neither import route writes **any** `backup_components` rows. An
imported bundle is a job row and some objects; the restore cart sees nothing to restore.

### The fact that decides the design

`dr-recover` works by *re-registering* rows that point at snapshots **already in this
cluster's repo**. An uploaded bundle's snapshot ids are meaningless here — the per-tenant
restic password is `HKDF(key, "restic-tenant-<id>")`, derived from *this* cluster's
`PLATFORM_ENCRYPTION_KEY`. A bundle exported from another region references snapshots in a
repo this cluster cannot open, under ids that mean nothing locally.

> **Import must RE-INGEST into the local repo and mint new snapshot ids. It cannot
> re-register the ones in `meta.json`.** That is the whole difference between import and DR
> recover, and it is why staging is unavoidable.

### Verified security finding in existing code

While validating "does restore check that a mailbox's domain belongs to the tenant?", the
answer is **no**, and the ordering makes it worse:

- `validateRestoreItemForTenant` gates the item *type* and `config-tables` table names. It
  does **not** look at a `mailboxes-by-address` selector's addresses.
- `isSafeAddress` is a *format* check (`/^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/`), not an
  ownership check.
- `mailboxes-by-address` calls `ensureStalwartPrincipals({ app, addresses })` **before** the
  snapshot-membership check that would reject an unknown address. So the side effect lands
  first and the validation that would have stopped it runs second.
- `ensureStalwartPrincipals` then **creates the Stalwart domain principal if missing**, and
  loads mailbox rows with `inArray(mailboxes.fullAddress, addresses)` — **globally scoped,
  no `tenantId` filter** — so it can recreate another tenant's mailbox principal from that
  tenant's own DB metadata, and back-fills `email_domains.stalwartDomainId` through a
  globally-unique `domains.domainName` lookup.

Today the blast radius is bounded because bundle contents come from capture, so the
addresses that survive to a successful restore are the tenant's own. **Import removes that
bound**: an uploaded bundle's addresses and component rows are attacker-supplied, so an
import could assert `admin@some-other-tenant.test` and reach principal creation.

## Decision

### D1 — Import re-ingests through a staging area; it does not re-register

Per snapshot unit — the `files` tree, and (per ADR-061) **each mailbox separately** —
extract that unit from the upload into a staging directory, run `restic backup <dir>`
natively, record the returned snapshot id, then delete the staged unit before the next one.

Native `restic backup <dir>` rather than `--stdin`: `--stdin` stores the stream as a single
blob, which would break selective file restore (`restic restore --include <path>`) and
per-mailbox restore. A unit staged as a directory produces a snapshot **shape-identical to a
capture**, so browse, selective restore, re-export and the restore cart all work with no
changes. That is what makes (2) answer itself.

### D2 — Staging is an `emptyDir` with a `sizeLimit` derived from `meta.json`, not a PVC

The restore Job's precedent is `emptyDir { sizeLimit: '50Gi' }` — no provisioning, and
overflow is contained: the kubelet evicts the Job rather than filling the node. (A bare
`emptyDir` with no `sizeLimit` is the Traefik spool leak.)

Size comes from the bundle, not the plan:

- `meta.json` carries `sizeBytes` per component, plus `addresses` and per-mailbox snapshot
  ids, and it is the **first entry in the tar** — a streaming reader knows the sizes before
  any payload arrives.
- Because units are staged one at a time, **peak staging is the largest single unit, not the
  bundle total**.

```
sizeLimit = clamp(max(unit sizeBytes) × SAFETY_FACTOR, FLOOR, PLATFORM_CEILING)
```

`meta.json` is supplied by whoever uploaded the archive and is **not trusted**. Under-
declaring only evicts the Job — a clean failure — but the `PLATFORM_CEILING` is what stops a
declared 4 TB. The extractor additionally enforces a real-bytes counter so a manifest that
lies larger than it declares is cut off at the limit rather than believed.

**The subscription quota is an admission check, not the staging size.** They answer
different questions: the quota asks "will the restored data fit this tenant's allowance?"
(checked in `import-preflight`, before a byte is accepted, rejected with a clear message);
the staging size asks "can the node hold the largest single unit transiently?". Sizing the
stage from the plan is wrong both ways — a large plan does not need a large stage for a
small bundle, and a small plan importing a bundle its own size still needs a stage that size.

### D3 — Transport reuses the upload-raw carve-out shape; tenants may self-import

Offsite-direct upload is not available to tenants and should not be. The existing rail is
`/api/v1/tenants/:tenantId/files/upload-raw`: carved out of the WAF (crowdsec only, no body
cap), streamed end-to-end into the tenant namespace, no platform-api buffering.

The import route takes the same shape. Note the WAF interaction:

- The import route must drop **both** the WAF and the cap, exactly as the upload and
  download carve-outs do. Justified identically: the body is an opaque compressed/encrypted
  archive that is streamed, never `io.ReadAll`'d, because the plugin is not in the chain.
- **A method restriction is not a substitute for dropping the WAF.** The download carve-out
  initially kept `modsecurity-crs` and dropped only the cap, on the reasoning that a
  ``Method(`GET`)`` term meant no request body existed to read. That was wrong: `Method()`
  matches the verb string and does not reject a GET carrying a body, and the plugin has no
  method check. Measured against the ingress with the WAF attached and the cap dropped, a
  GET with a 40 MiB body uploaded **all 41,943,040 bytes** before ModSecurity answered,
  against 1,113,941-then-413 on a capped route — i.e. the 600 MB OOM, reachable on a GET.
- **Nor can a smaller request-only cap substitute**: `waf-body-limit` is a `buffering`
  middleware, and any buffering middleware spools the whole RESPONSE to disk whatever its
  request settings. Adding one back would re-introduce the download stall.
- `ci-waf-body-limit-check.sh`'s route scan enforces the corrected invariant: **a route that
  attaches the WAF must attach the cap**, with no method exception.

### D4 — Tenant self-import is restricted to `files` and `mailboxes`

`config` restores platform DB rows and `secrets` carries **TLS private keys**. A tenant
importing their own secrets is defensible; an uploaded archive *asserting* someone else's is
not, and the value is not worth the surface. Tenant-scoped import accepts `files` and
`mailboxes` and **drops the other components with an explicit, surfaced count** — never
silently. Admin import keeps all four.

The target tenant is always the **caller's** tenant. `meta.tenantId` is informational and is
replaced, exactly as the admin path already does.

### D5 — Mailbox addresses are verified against tenant-owned domains before any side effect

Every address in an import (and, as a hardening, in a `mailboxes-by-address` cart item) is
checked so that its domain resolves to an `email_domains` row belonging to the **target
tenant**, and the check happens **before** `ensureStalwartPrincipals` can create anything.
Addresses failing the check are refused with a named error; an import refuses the mailbox
unit rather than importing a subset silently.

This also fixes the pre-existing ordering defect: validate, then act.

### D6 — Everything the import creates is reaped, on success and on failure

Import creates four kinds of artifact, and each needs an owner:

| artifact | reaped by |
|---|---|
| staged unit directory | deleted after each unit; whole stage is an `emptyDir`, gone with the pod |
| import Job | `ttlSecondsAfterFinished`, as the restore Job already sets |
| partial restic snapshots from a failed run | tagged `import-<importId>`; a failed import prunes its own tag |
| `backup_jobs` / `backup_components` rows for an aborted import | written **only after** all units succeed |
| an upload abandoned mid-stream | the Job exits on `request.raw` `aborted`/`close`, as `internal-upload-route` already does |

The rows-last ordering is deliberate: a half-imported bundle must never be visible to the
restore cart. Either the bundle is registered complete, or it does not exist.

## Consequences

- An imported bundle is indistinguishable from a captured one. Restore, browse, selective
  restore and re-export need no changes — this is what makes the restore half free.
- Import cost is a Job plus transient node disk bounded by the largest unit.
- Cross-region import works, because re-ingestion re-encrypts under the target cluster's
  derived password.
- The 12.5 MiB ceiling disappears for the import path only; every other POST keeps the cap.
- A bundle whose largest single unit exceeds `PLATFORM_CEILING` cannot be imported by upload.
  That is a deliberate limit, surfaced in `import-preflight` rather than discovered by a
  Job eviction.

## Alternatives considered

**Re-register `meta.json`'s snapshot ids (the `dr-recover` shape).** Rejected: only valid
when the snapshots are already in this cluster's repo under this tenant's derived password.
It is right for DR recover and wrong for an upload, and the failure mode is a bundle that
registers cleanly and then cannot be restored.

**`restic backup --stdin` straight from the upload, no staging.** Rejected: stores each unit
as one blob, breaking selective and per-mailbox restore and creating a second class of bundle
the browse UI must special-case. The codebase already carries that scar — the pre-ADR-061
whole-tenant `maildir.tar` branch still in `export-sources.ts`.

**A PVC per import sized from the subscription quota.** Rejected: provisioning cost and
lifecycle for a transient need, and the quota is the wrong number (see D2).

**Keep the buffered multipart import and just raise the caps.** Rejected: the WAF cap is not
ours to raise on a POST without reopening the OOM hole, and platform-api would hold the
archive twice regardless.
