# ADR-049: Login passwords (app passwords) as the mailbox credential system

**Status:** Accepted (2026-06-07)

## Context

A mailbox historically had a single operator-typed primary password,
stored platform-side (bcrypt in `mailboxes.password_hash`) and mirrored
in cleartext to Stalwart at create/update time (a standing security
concern: M1, 2026-05-03). Every device + webmail shared that one secret;
revoking one device meant rotating everything, and the platform held a
mailbox secret at rest.

Stalwart 0.16 natively supports **app passwords** — per-account
secondary credentials (`x:AppPassword/*` over JMAP) where the server
generates the secret (shown once), they authenticate anywhere the
primary does (IMAP/SMTP/POP3/JMAP/CalDAV/CardDAV), carry an optional
expiry + IP allow-list, and are individually revocable. A spike
(2026-06-07) verified: the admin/master session can create them for any
account; they work across all protocols + Roundcube + Bulwark; and
revocation takes effect immediately.

## Decision

Make **login passwords** (the UI name for Stalwart app passwords) the
human-facing credential system for a mailbox.

- **The primary password becomes internal.** On mailbox create the
  backend mints a random primary, sets it in Stalwart, and stores
  **nothing** platform-side (`password_hash` is now nullable, migration
  0052 — "generate-and-forget"). No human ever sees or types it; the
  account simply needs one valid primary credential to be a normal
  Stalwart user. If ever needed it is re-randomised, never surfaced.
- **Login passwords are the credential UI.** Create returns the
  server-generated secret **once**; list shows metadata only (Stalwart
  masks the secret `****` and we drop even that). Per credential: label
  (required — it's how you revoke the right one later), optional expiry,
  optional IP/CIDR allow-list. Revoke = destroy the Stalwart object,
  instantly.
- **Stateless.** No platform DB table for login passwords — Stalwart is
  the store; the list is read live over JMAP. Create/revoke are audited
  (label + id + actorRole, never the secret).
- **Mailbox create auto-issues the first login password** ("Initial",
  revealed once) so there's never a dead account.
- **No typed mailbox password anywhere.** `password` removed from the
  create/update API contracts; the password reset path is retired
  (reset = revoke + issue a new login password). Drift-recreate mints a
  fresh hidden primary instead of replaying a stored hash.

## Scope (this phase)

- Managed by **tenant-admin** (tenant panel) + **support/super_admin**
  (admin panel). Mailbox owners have no platform login, so end-user
  self-service is out of scope (would need a new mailbox-user surface).
- Existing mailboxes are untouched (backward compatible): their stored
  primary keeps working until they transition to login passwords. No
  forced migration (no production cluster yet).

## Consequences

- The platform holds **zero** mailbox secrets at rest — the M1 cleartext
  concern is fully retired for new mailboxes.
- Per-device revocation, expiry, and IP-pinning come for free from
  Stalwart.
- Webmail login uses a login password (both engines accept them;
  Bulwark impersonation via master creds is unaffected).
- Trade-off: an operator who never issues/saves a login password leaves
  a user unable to log in — mitigated by auto-issuing the first one at
  create and surfacing it once.
