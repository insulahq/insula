#!/usr/bin/env python3
"""
imap-sync.py — IMAP-based per-tenant mailbox capture for tenant-bundles.

Replaces (or coexists with) jmap-sync.py for the per-tenant mailbox
component. Stalwart 0.16+ IMAP4rev2 + MULTIAPPEND + UTF8=ACCEPT is the
target server.

This script always does a COMPLETE pull — tenant bundles are non-
incremental by design. No `Email/changes`-equivalent CONDSTORE wiring.

Output Maildir tree (matches jmap-sync.py so jmap-restore.py /
imap-restore.py can consume either flavor):

    <output-dir>/<account-address>/<mailbox-name>/cur/<unix>.<unique>:2,<flags>

`<flags>` is the Maildir flag suffix (cr.yp.to/proto/maildir.html):
  S = \\Seen, F = \\Flagged, R = \\Answered, T = \\Deleted, D = \\Draft

Custom IMAP keywords ($Junk, $Forwarded, etc.) are intentionally dropped
on capture for symmetry with the existing JMAP path. Re-introducing
them would require a sidecar file per message and corresponding
restore-side wiring — out of scope for the v1 IMAP migration.

Auth: master-user proxy. Username = `<addr>%<master_fq>`, password is
the master principal's password (read from env, key named by
--auth-pass-env). This is the same model used by jmap-sync.py.

Failure modes:
  - LOGIN failure: exit 2 with reason on stderr.
  - Per-folder failure: logged, that folder skipped, summary records `skipped`.
  - Per-message failure: logged, that message skipped, summary records `skipped`.

Output:
  - stdout: single JSON line `{"address": ..., "fetched": N, "skipped": M,
    "folders": F, "elapsedSeconds": T, "engine": "imap"}`
  - exit 0 on success, non-zero on fatal error.

Stdlib only — no third-party deps.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any

# Note: helper is in the same image dir; the Job's PYTHONPATH includes /usr/local/bin.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from imap_client import (  # noqa: E402
    ImapClient,
    ImapError,
    custom_keywords,
    deterministic_unique,
    maildir_flags_suffix,
)


def _log(msg: str) -> None:
    sys.stderr.write(f"imap-sync: {msg}\n")
    sys.stderr.flush()


def _safe_filename(s: str) -> str:
    """Sanitize a folder name for inclusion in a filesystem path."""
    # Keep dots + dashes; replace path separators + control chars + the
    # IMAP hierarchy delimiter (typically '/' or '.').
    return re.sub(r"[^A-Za-z0-9._@-]", "_", s)


def _write_message(
    output_dir: str,
    account_address: str,
    folder: str,
    uid: int,
    body: bytes,
    flags: frozenset[str],
) -> str:
    """
    Write one captured message to the Maildir layout. Returns its path.

    Custom IMAP keywords ($Junk, $Forwarded, server-defined flags etc.)
    don't fit the Maildir 1-char system-flag suffix, so we write them
    to a `<msg-filename>.keywords` sidecar — one keyword per line.
    On restore, imap-restore.py reads the sidecar and includes the
    custom keywords in the MULTIAPPEND/APPEND flag block. Absent
    sidecar = no custom keywords (backwards compatible with snapshots
    written before this change).
    """
    suffix = maildir_flags_suffix(flags)
    unique = deterministic_unique(uid, folder)
    fname = f"{unique}:2,{suffix}"
    addr_dir = _safe_filename(account_address)
    mb_name = _safe_filename(folder)
    target_dir = os.path.join(output_dir, addr_dir, mb_name, "cur")
    os.makedirs(target_dir, exist_ok=True)
    target_path = os.path.join(target_dir, fname)
    # Atomic write: tmp file in same dir, then rename.
    tmp = target_path + ".part"
    with open(tmp, "wb") as f:
        f.write(body)
    os.rename(tmp, target_path)
    # Sidecar with custom keywords if any are set. We skip writing the
    # file at all when there are none — keeps the maildir tree tidy.
    extras = custom_keywords(flags)
    if extras:
        sidecar = target_path + ".keywords"
        sidecar_tmp = sidecar + ".part"
        with open(sidecar_tmp, "w", encoding="utf-8") as f:
            for kw in sorted(extras):
                f.write(kw + "\n")
        os.rename(sidecar_tmp, sidecar)
    return target_path


def run(args: argparse.Namespace) -> int:
    pw = os.environ.get(args.auth_pass_env, "")
    if not pw:
        _log(f"env {args.auth_pass_env!r} is empty")
        return 2

    auth_user = f"{args.account_address}%{args.master_user}"
    t_start = time.time()
    fetched = 0
    skipped = 0
    folder_count = 0

    try:
        with ImapClient(
            args.imap_host,
            args.imap_port,
            verify_tls=args.verify_tls,
            on_log=_log,
        ) as client:
            client.login(auth_user, pw)
            # Enable UTF-8 mailbox names + (optionally) CONDSTORE. We don't
            # USE CONDSTORE for sync — bundles are COMPLETE — but enabling
            # is harmless and means STATUS reports include HIGHESTMODSEQ
            # for operator-side observability.
            client.enable("UTF8=ACCEPT")

            folders = client.list_folders()
            _log(f"address={args.account_address} folders={len(folders)}")

            for folder in folders:
                # Skip \Noselect — those are pure hierarchy nodes.
                if "\\Noselect" in folder.flags:
                    continue
                folder_count += 1
                try:
                    status = client.select(folder.name, readonly=True)
                except ImapError as e:
                    _log(f"SELECT {folder.name!r} failed: {e}; skipping folder")
                    skipped += 1
                    continue

                exists = status.get("EXISTS", 0)
                if exists == 0:
                    _log(f"folder={folder.name!r} empty; ensuring dir exists")
                    # Still create the empty Maildir dir + .imap-name +
                    # .special-use so restore can CREATE the folder with
                    # the correct name + role even though there are no
                    # messages.
                    addr_dir = _safe_filename(args.account_address)
                    mb_name = _safe_filename(folder.name)
                    folder_root = os.path.join(args.output_dir, addr_dir, mb_name)
                    os.makedirs(os.path.join(folder_root, "cur"), exist_ok=True)
                    with open(os.path.join(folder_root, ".imap-name"), "w") as f:
                        f.write(folder.name)
                    if folder.special_use:
                        with open(os.path.join(folder_root, ".special-use"), "w") as f:
                            f.write(" ".join(sorted(folder.special_use)))
                    continue

                folder_fetched = 0
                folder_skipped = 0
                try:
                    for uid, flags, body in client.fetch_all_bodies():
                        try:
                            _write_message(
                                args.output_dir,
                                args.account_address,
                                folder.name,
                                uid,
                                body,
                                flags,
                            )
                            folder_fetched += 1
                        except OSError as e:
                            _log(
                                f"write fail uid={uid} folder={folder.name!r}: {e}"
                            )
                            folder_skipped += 1
                except ImapError as e:
                    _log(f"FETCH stream {folder.name!r} aborted: {e}")
                    folder_skipped += max(0, exists - folder_fetched)

                fetched += folder_fetched
                skipped += folder_skipped

                # Write the special-use marker so restore can request the
                # same role on CREATE. One per folder; small file.
                addr_dir = _safe_filename(args.account_address)
                mb_name = _safe_filename(folder.name)
                folder_root = os.path.join(args.output_dir, addr_dir, mb_name)
                os.makedirs(folder_root, exist_ok=True)
                # Always write .imap-name so restore can reconstruct the
                # exact IMAP folder name (filesystem-sanitization is lossy
                # for spaces / non-ASCII — e.g. "Sent Items" → "Sent_Items").
                with open(os.path.join(folder_root, ".imap-name"), "w") as f:
                    f.write(folder.name)
                if folder.special_use:
                    with open(os.path.join(folder_root, ".special-use"), "w") as f:
                        f.write(" ".join(sorted(folder.special_use)))

                _log(
                    f"folder={folder.name!r} exists={exists} "
                    f"fetched={folder_fetched} skipped={folder_skipped}"
                )

    except ImapError as e:
        _log(f"fatal IMAP error: {e}")
        return 2
    except OSError as e:
        _log(f"fatal I/O error: {e}")
        return 3

    elapsed = round(time.time() - t_start, 2)
    summary: dict[str, Any] = {
        "address": args.account_address,
        "fetched": fetched,
        "skipped": skipped,
        "folders": folder_count,
        "elapsedSeconds": elapsed,
        "engine": "imap",
    }
    sys.stdout.write(json.dumps(summary) + "\n")
    sys.stdout.flush()
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="IMAP → Maildir capture for tenant-bundles (replaces jmap-sync.py)"
    )
    p.add_argument(
        "--imap-host",
        required=True,
        help="Stalwart IMAP host (e.g. stalwart-mail.mail.svc.cluster.local)",
    )
    p.add_argument("--imap-port", type=int, default=993, help="IMAPS port (default 993)")
    p.add_argument(
        "--account-address",
        required=True,
        help="Tenant mailbox to capture (e.g. user@tenant.example)",
    )
    p.add_argument(
        "--master-user",
        required=True,
        help="Master principal FQ (e.g. master@master.local) used for proxy auth",
    )
    p.add_argument(
        "--auth-pass-env",
        required=True,
        help="Env-var name holding the master principal's password",
    )
    p.add_argument(
        "--output-dir",
        required=True,
        help="Root of the Maildir output tree",
    )
    p.add_argument(
        "--verify-tls",
        action="store_true",
        help="Verify Stalwart's TLS certificate. Default off — cluster-internal "
        "uses self-signed; production overlay should pin a CA + flip this on.",
    )
    return p.parse_args(argv)


if __name__ == "__main__":
    sys.exit(run(_parse_args()))
