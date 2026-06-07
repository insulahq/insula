# ADR-047: Fixed alternating DKIM selectors (dkim-1 / dkim-2)

**Status:** Accepted (2026-06-07)
**Supersedes:** the per-rotation timestamped selector scheme (`dkim-<yyyymmddHHMMSS>`) introduced with the manual-rotation endpoint.

## Context

DKIM rotation must keep the *old* public key resolvable in DNS until mail
signed with it has cleared receivers' retry queues (greylisting: minutes;
tempfail retries: up to ~5 days). Two schemes satisfy that:

1. **Timestamped selector per rotation** — every rotation mints a new
   selector and publishes a new TXT record; old records are retired later.
2. **Fixed alternating pair (A/B)** — the Microsoft 365
   `selector1`/`selector2` pattern: keys live under exactly two fixed
   selector names; rotation flips signing to the *other* selector with a
   fresh key, replacing the key from two rotations ago.

We shipped (1) first. Its real cost only shows for tenants whose DNS is
hosted *externally*: every rotation requires them to manually add a new
TXT record, and the zone accumulates dead selectors unless someone
retires them (the platform deliberately has no auto-retirement).

A single fixed selector (asked and answered 2026-06-07) is *almost*
workable given rare rotation, but replacing the key in place creates a
bounded verification-failure window (DNS TTL skew + retry-queue
residence) whose only victims — forwarded mail under `p=reject` — fail
silently. The A/B pair removes that window at no extra cost.

## Decision

- Selectors are fixed: **`dkim-1`** and **`dkim-2`**
  (`backend/src/modules/email-dkim/selectors.ts`).
- `email_domains.dkim_active_selector` (migration 0051) records which
  selector currently signs; rotation flips it. NULL = legacy domain —
  its first rotation targets `dkim-1` and converges it.
- **Enable / drift-repair normalization**
  (`email-dkim/normalize.ts`): Stalwart's auto-created signature pair
  (`v1-rsa-<date>` + Gmail-unverifiable `v1-ed25519-<date>`, created on
  every domain principal regardless of `Bootstrap.generateDkimKeys`) is
  replaced by one platform-generated RSA-2048 signature under `dkim-1`.
  Create-before-destroy; soft-fail keeps the auto pair signing.
- **Rotation** (`email-dkim/rotate.ts`): destroy any signature on the
  *target* selector (the ≥2-rotations-old key) plus stragglers (only
  when the current selector's signature exists — recent mail then
  carries both signatures), mint a fresh RSA-2048 key under the target,
  **keep the previous selector's signature active** (dual-signing; its
  TXT stays published via the dns-sync ownership model), upsert the
  target's TXT record (selector reuse must replace, not duplicate —
  two `v=DKIM1` TXT records at one name is a verifier-dependent
  permfail, RFC 6376 §3.6.2.2), persist the flip.
- **No retirement, ever.** Both TXT records are permanent zone fixtures.
  The `recommendedRetireOldAt` response field is gone.

## Consequences

- External-DNS tenants configure two TXT records once; rotations never
  require DNS changes again.
- In steady state each domain has exactly two active Stalwart
  signatures (both verify — multiple DKIM-Signature headers are
  standard); before the first rotation, exactly one (`dkim-1`).
- Constraint: don't rotate the same domain twice within the ~5-day mail
  retry horizon (the reused selector's old key disappears). The UI
  keeps a confirmation modal; selector count is bounded at two by
  design, so accidental fan-out is impossible.
- RSA-only policy unchanged (Gmail/M365 cannot verify RFC 8463
  ed25519-sha256 — see support.stalw.art/t/562).
- Existing clusters: no data migration (no production servers as of
  this ADR); legacy domains converge on first rotation or re-enable.
