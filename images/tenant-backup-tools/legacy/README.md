# Legacy mailbox scripts

These scripts are **archived but still shipped in the image** as a fallback
for the JMAP path. They are no longer the default — the platform now uses
IMAP MULTIAPPEND via `../imap-sync.py` and `../imap-restore.py` (Phase 1 of
the 2026-05-22 JMAP→IMAP migration).

## Why archived

Re-measured perf showed JMAP (production code, parallel workers + batched
`Email/import`) is only ~9% slower than IMAP MULTIAPPEND on the same
single-pod local-path Stalwart stack — far less of a gap than the initial
naive-comparison number suggested. The IMAP path is the new default because:

- Simpler protocol (raw RFC 822 over TCP, no JSON wrapping)
- Native `MULTIAPPEND` + `LITERAL+` + `CONDSTORE` support in Stalwart 0.16+
- `imap-sync.py`/`imap-restore.py` are smaller and easier to audit
- Byte-budgeted batching makes the 100 MiB `x:Imap.maxRequestSize` cap a
  hard guarantee (Phase 1 commit `34f50e54`)

JMAP is kept available as a one-toggle fallback per the operator's
direction (don't delete — might be needed for future Stalwart releases or
operator preference).

## How to revert to JMAP

UI: `/settings/email > Backup Engine > JMAP (legacy)` then Save.
SQL: `UPDATE platform_settings SET setting_value='jmap' WHERE setting_key='mailbox_backup_engine';`

The change applies to the next bundle the orchestrator dispatches; running
Jobs are not affected.

## Status of each file

| File | Role | Still working? |
|---|---|---|
| `jmap-sync.py` | Per-tenant mailbox capture (incremental dropped 2026-05-22 Phase 3 — now COMPLETE-only) | ✅ Yes |
| `jmap-restore.py` | Per-tenant mailbox restore via `Blob/upload` + `Email/import` | ✅ Yes |
| `jmap-seed.py` | E2E test seeder for `scripts/integration-tenant-bundles-jmap-full-e2e.sh` | ✅ Yes — still used by harness |
| `jmap-sync-test.py` | Ad-hoc sanity script used during Phase 2 development | ✅ Yes |
| `jmap-verify.py` | Post-bundle JMAP-side verification helper | ✅ Yes |
| `restore-mailbox.py` | Original IMAP-APPEND restore (pre-Phase 2, replaced by `jmap-restore.py`) | ✅ Yes — second-tier fallback |

The `Dockerfile` still copies all of these into `/usr/local/bin/` so the
in-image path is unchanged. Orchestrator code (`mailboxes.ts`,
`mailboxes-by-address.ts`) selects between IMAP and JMAP based on
`platform_settings.mailbox_backup_engine`; both engines point at the same
in-image script locations.
