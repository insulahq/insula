# Mailbox Aliases

Per-mailbox aliases attach **extra addresses to an existing mailbox** —
`info@`, `postmaster@`, `webmaster@`, `hostmaster@`, … — with full
**receive + send-as** semantics. They are distinct from **Mailing Lists**
(formerly "Aliases & Forwarding"): a mailing list is a mailbox-less
address fanning out to up to 20 destinations; a mailbox alias belongs to
exactly one mailbox and additionally authorizes replying *as* the alias.

## Semantics

| | Mailbox alias | Mailing list |
|---|---|---|
| Delivers to | its one mailbox | 1–20 destinations (local or external) |
| Send-as from the address | **yes** (server-enforced) | no |
| Webmail From selector | yes (identity auto-pushed) | no |
| Backing Stalwart object | entry in the account's `aliases` map | `x:MailingList` principal |
| Plan quota | never counted | never counted |

- **Enabled** alias: accepts inbound (RCPT) and authorizes `MAIL FROM`
  on submission. **Disabled**: both directions refuse immediately
  (550 / 501) — the map entry stays, reserving the address server-side.
- Address uniqueness spans mailboxes, mailing lists, and aliases —
  checked platform-side (clean 409) with Stalwart's own
  `primaryKeyViolation` as the backstop.
- v1 is **same-domain only**: an alias lives on its mailbox's email
  domain, so it always dies with the account at domain teardown.

## Where it lives

- **Tenant panel:** Email → Mailboxes → *Edit* → **Aliases** section
  (add / enable / disable / remove, applied immediately).
- Enabled aliases + forwarding targets are shown on the mailbox rows in
  both panels' email-account tables (admin: Email Accounts tab and the
  tenant-detail Email tab, read-only).
- API: `GET/POST /tenants/:tid/email/mailboxes/:id/aliases`,
  `GET /tenants/:tid/email/mailbox-aliases?mailbox_id=`,
  `PATCH/DELETE /tenants/:tid/email/mailbox-aliases/:id`
  (contracts: `@insula/api-contracts` `mailbox-aliases.ts`).

## Implementation notes (Stalwart 0.16, verified live 2026-08-25)

- The account's `aliases` map is pushed **whole** from the
  `mailbox_aliases` rows (`stalwart-jmap/account-aliases.ts`) — a
  positional map derived through one function everywhere, so a partial
  failure or out-of-band edit converges on the next push or sweep.
- **JMAP identities materialize once** at the account's first
  `Identity/get` and are never re-derived by Stalwart. The platform
  therefore pushes/destroys the send-as Identity itself (admin
  impersonation, resolved **by address**, never by stored id — restores
  self-heal). Bulwark re-syncs identities at login and every ~30 min;
  a freshly added alias appears in its From selector after that.
- Convergence surface (all idempotent, boot + 15-min sweep in
  `mailbox-aliases/aliases-reconcile.ts`): account alias maps (out-of-band
  Stalwart aliases are **removed** — the platform DB is authoritative),
  identities for enabled/disabled rows, plus the existing mail-rules and
  mailing-list reconciles.
- Lifecycle: rows cascade with the mailbox/domain/tenant; tenant archive
  destroys the account principals first (aliases + identities die with
  them). Tenant bundles carry `mailbox_aliases` in the config-tables
  component; `ensure-stalwart-principals` re-applies the alias map +
  identities when it recreates an account.
- Suspension (tenant suspend or per-mailbox disable, operator decision
  2026-08-26): the account's whole mail surface shuts down — the alias
  map is pushed all-off (RCPT 550 / send-as 501), inbound to the primary
  is bounced by an ereject script, and the `authenticate` permission is
  disabled (no submission/IMAP/webmail). Alias rows and identities keep
  the configuration; reactivation restores everything. Permission writes
  always compose the FULL desired set via `buildAccountPermissions` —
  Stalwart stores the last permissions patch verbatim, so incremental
  patches from different features clobber each other (probed live).
