# tenant-backup-tools (image still named mail-backup-tools for the
# Phase 1 window — rename to tenant-backup-tools deferred to a cleanup
# PR per ADR-036 roadmap).
#
# Used by:
#   - Tenant Backup Phase 1 files component (tar | curl --upload-file -
#     to platform-api restic-stream endpoint; restic runs server-side)
#   - Tenant Backup Phase 4 mailbox component (mbsync IMAP master-user
#     proxy → Maildir tarball; replaced by JMAP in Phase 2)
#
# Phase 1 (ADR-036) tooling additions:
#   - restic           — for cross-region restore Jobs (Phase 1.5+)
#   - debian:trixie-slim base — matches peer-firewall-reconciler so the
#                        platform's distinct base-image surface stays small.
#                        Container nft >= host nft constraint that the
#                        firewall image set lives by also matters here for
#                        future restic-running Jobs.
#
# Tools shipped:
#   - restic            — Phase 1.5+ cross-region restore inside tenant ns
#                         (server-side restic runs on platform-api;
#                         this image is for restore-side pulls)
#   - python3           — Phase 2 jmap-sync.py + existing restore-mailbox.py.
#                         NOT python3-minimal: that variant strips `shutil`
#                         which `urllib.error` transitively imports via
#                         tempfile → shutil. Caught on staging 2026-05-11:
#                         `ModuleNotFoundError: No module named 'shutil'`
#                         crashed jmap-sync.py at line 1.
#   - curl              — upload + download artifacts, HMAC tokens
#   - tar + gzip        — files-component pipeline
#   - coreutils         — sha256sum + standard tools (debian default)
#   - ca-certificates   — TLS to platform-api + S3
#   - isync             — mbsync, mailbox component (until Phase 2 JMAP)
#   - rsync             — mail-migration rsync Job (backend/src/modules/
#                         mail-admin/migration.ts) copies the live RocksDB
#                         data between server nodes. Without this the
#                         migration shell exits with "rsync: not found"
#                         and the Job hits backoffLimit.
#   - openssh-client    — provides ssh + ssh-keyscan used by the rsync
#                         transport in the migration Job. Mirrors the
#                         "uses ssh -i /etc/migration-ssh/id_rsa" path
#                         in the Job shell script.
#
# Image size budget: <120 MiB (debian:trixie-slim ~80 MiB base + restic
# ~25 MiB + python3-minimal ~10 MiB). Trivy CRITICAL/HIGH must pass.

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      restic \
      isync \
      python3 \
      curl \
      tar \
      gzip \
      coreutils \
      ca-certificates \
      rsync \
      openssh-client \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
           /usr/share/doc/* /usr/share/man/*

# Legacy capture helper — wraps mbsync + Option F streaming upload.
# Argv: capture-mailbox.sh <addr> <upload_url>
# Pre-JMAP; pre-IMAP-MULTIAPPEND. Kept in image as a 3rd-tier fallback.
COPY capture-mailbox.sh /usr/local/bin/capture-mailbox.sh
RUN chmod 755 /usr/local/bin/capture-mailbox.sh

# ─────────────────────────────────────────────────────────────────────────
# Active engine (2026-05-22 onward) — IMAP MULTIAPPEND. Default per
# platform_settings.mailbox_backup_engine. See ../legacy/README.md for
# why JMAP is no longer default and how to revert if needed.
# ─────────────────────────────────────────────────────────────────────────
# imap_client.py — raw-socket IMAP4rev2 helper. Imported by both
# imap-sync.py and imap-restore.py via sys.path.insert(0, dirname(__file__)).
COPY imap_client.py /usr/local/bin/imap_client.py
RUN chmod 644 /usr/local/bin/imap_client.py

# Argv: imap-sync.py --imap-host <h> --imap-port <p> --account-address <a>
#       --master-user <fq> --auth-pass-env <ENV> --output-dir <dir>
COPY imap-sync.py /usr/local/bin/imap-sync.py
RUN chmod 755 /usr/local/bin/imap-sync.py

# Argv: imap-restore.py --imap-host <h> --imap-port <p>
#       --target-address <a> --source-address <a> --master-user <fq>
#       --auth-pass-env <ENV> --maildir-root <dir> --mode <m>
COPY imap-restore.py /usr/local/bin/imap-restore.py
RUN chmod 755 /usr/local/bin/imap-restore.py

# ─────────────────────────────────────────────────────────────────────────
# Legacy engine (kept in image as fallback) — JMAP via jmap-sync.py /
# jmap-restore.py. Orchestrator picks JMAP when
# platform_settings.mailbox_backup_engine='jmap'. See legacy/README.md.
# Files live under legacy/ in the source tree but install at
# /usr/local/bin/ so orchestrator script paths don't have to know.
# ─────────────────────────────────────────────────────────────────────────
COPY legacy/jmap-sync.py /usr/local/bin/jmap-sync.py
RUN chmod 755 /usr/local/bin/jmap-sync.py

COPY legacy/jmap-restore.py /usr/local/bin/jmap-restore.py
RUN chmod 755 /usr/local/bin/jmap-restore.py

# ─────────────────────────────────────────────────────────────────────────
# Auxiliary surfaces (2026-05-22) — Sieve scripts, contacts, calendars,
# vacation responses. These live OUTSIDE the Maildir tree but inside the
# per-account scope, so the mail Job runs jmap-aux-sync.py per address
# after the main mail capture, and the restore executor runs
# jmap-aux-restore.py after the main mail restore. Both use the same
# master-proxy auth + same JMAP transport as the legacy mail scripts.
# See ADR-044 for the design rationale.
# ─────────────────────────────────────────────────────────────────────────
COPY jmap_aux_client.py /usr/local/bin/jmap_aux_client.py
RUN chmod 644 /usr/local/bin/jmap_aux_client.py

COPY jmap-aux-sync.py /usr/local/bin/jmap-aux-sync.py
RUN chmod 755 /usr/local/bin/jmap-aux-sync.py

COPY jmap-aux-restore.py /usr/local/bin/jmap-aux-restore.py
RUN chmod 755 /usr/local/bin/jmap-aux-restore.py

# E2E test seeder — used by scripts/integration-tenant-bundles-jmap-full-e2e.sh
# to inject N marked messages via Email/import. Same auth + endpoint-rebase
# pattern as jmap-sync.py. Pure Python stdlib.
COPY legacy/jmap-seed.py /usr/local/bin/jmap-seed.py
RUN chmod 755 /usr/local/bin/jmap-seed.py

# Pre-JMAP IMAP-APPEND restore. 3rd-tier fallback below JMAP fallback.
COPY legacy/restore-mailbox.py /usr/local/bin/restore-mailbox.py
RUN chmod 755 /usr/local/bin/restore-mailbox.py

# Phase 2.5 (ADR-036): restic upload sidecar for stalwart-snapshot CronJob.
# Waits for /snapshot/done, runs restic backup, reports stats to platform-api.
COPY snapshot-upload.sh /usr/local/bin/snapshot-upload.sh
RUN chmod 755 /usr/local/bin/snapshot-upload.sh

# 2026-05-13: Stalwart-native, app-level archive uploader/downloader.
# Two modes, dispatched on ARCHIVE_MODE env:
#   export  — reads /export/export.lz4 (written by the initContainer
#             that ran `stalwart -e`), uploads via restic --tag mail-archive,
#             prints `archive-result: {...}` JSON line for the orchestrator
#             to parse the resulting restic snapshot id.
#   restore — restic restores --target /export, hands off to the initContainer
#             (which runs `stalwart -i`).
# Reuses the stalwart-snapshot-restic-repo Secret so operators configure
# one repo for both continuous backup AND archive.
COPY archive-export.sh /usr/local/bin/archive-export.sh
RUN chmod 755 /usr/local/bin/archive-export.sh

# Default to a no-op so `docker run …` doesn't error; the orchestrator
# always overrides command/args.
CMD ["sh", "-c", "echo tenant-backup-tools image ready; sleep 1"]
