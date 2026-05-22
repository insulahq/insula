#!/usr/bin/env python3
"""
imap-restore.py — IMAP MULTIAPPEND restore for tenant-bundles.

Reads a Maildir tree produced by imap-sync.py (or jmap-sync.py — output
shape is identical) and appends every message into the target Stalwart
account via the IMAP path. Replaces (or coexists with) jmap-restore.py.

Restore modes (match jmap-restore.py):
  merge-skip-duplicates  default — UID SEARCH HEADER Message-ID, skip
                         messages already present on target.
  merge-overwrite        no dedup; every snapshot file is APPENDed.
                         Will create duplicates if target already has
                         the same messages.
  replace                STORE 1:* +FLAGS \\Deleted ; EXPUNGE on every
                         existing target folder BEFORE importing.
                         Destructive — wipes the target account's mail.

## Byte-budgeted MULTIAPPEND (the operator's explicit requirement)

Stalwart 0.16 caps IMAP request size at `x:Imap.maxRequestSize`
(default 50 MiB; raised to 100 MiB cluster-wide in bootstrap.sh commit
de17d40d). With LITERAL+ (non-synchronizing) literals, the cap applies
to the CUMULATIVE bytes of the APPEND command — Stalwart can't tell
where the command ends without parsing all literals, so it buffers the
whole thing. With SYNC literals (await `+ Ready` per literal) the cap
applies per-literal only.

Our algorithm:

    REQUEST_CAP            = 100 MiB  (matches x:Imap.maxRequestSize)
    LITERAL_PLUS_BUDGET    =  80 MiB  (leave 20 MiB headroom for the
                                       APPEND command framing + parser)
    SOLO_SYNC_THRESHOLD    =  10 MiB  (msgs over this go in their own
                                       SYNC-literal APPEND — no
                                       cumulative buffer risk)
    SKIP_THRESHOLD         =  90 MiB  (per-literal must be < 100 MiB
                                       cap; leave 10 MiB headroom)

For each folder's pending messages we sort into:
  * LARGE_OVERSIZE  (>= SKIP_THRESHOLD)      → skipped with logged warning
  * LARGE           (>= SOLO_SYNC_THRESHOLD) → 1-msg SYNC APPEND each
  * SMALL           (else)                   → packed into LITERAL+
                                               batches up to budget

## Maildir → IMAP flag mapping

The Maildir filename suffix `:2,SFRDT` maps to system flags only:
  S → \\Seen      F → \\Flagged   R → \\Answered
  D → \\Draft     T → \\Deleted

Custom keywords ($Junk, $Forwarded, etc.) are NOT carried in the
Maildir filename — symmetric with the export side. Reintroducing them
would require a sidecar file per message; out of scope for v1.

## Auth + output

Same master-user proxy auth as imap-sync.py:
  username = `<target-address>%<master-user>`
  password = env-var named by --auth-pass-env

Output: single JSON summary on stdout. Same shape as jmap-restore.py:
  {address, imported, skipped, failed, mailboxesCreated, elapsedSeconds, engine}

Stdlib only.
"""
from __future__ import annotations

import argparse
import email.parser
import email.policy
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from imap_client import (  # noqa: E402
    FolderInfo,
    ImapClient,
    ImapError,
)


# ── Tunables (defaults match the operator-set 100 MiB Stalwart cap) ──────────

MIB = 1024 * 1024
REQUEST_CAP = 100 * MIB         # x:Imap.maxRequestSize default after bootstrap.sh fix
LITERAL_PLUS_BUDGET = 80 * MIB  # cumulative batch budget for LITERAL+ MULTIAPPEND
SOLO_SYNC_THRESHOLD = 10 * MIB  # >= 10 MiB → individual SYNC APPEND
SKIP_THRESHOLD = 90 * MIB       # >= 90 MiB → skip (over per-literal cap)

# How many small messages per MULTIAPPEND batch even if we're well under
# the byte budget. ~200 was the throughput-ceiling sweet spot in perf
# testing — going higher gives <4% additional throughput. Going lower
# pays more round-trip cost.
MAX_BATCH_COUNT = 200

# Maildir flag suffix `:2,<chars>`.
MAILDIR_FLAG_RE = re.compile(r":2,([A-Z]*)$")
MAILDIR_FLAG_TO_IMAP = {
    "S": "\\Seen",
    "F": "\\Flagged",
    "R": "\\Answered",
    "D": "\\Draft",
    "T": "\\Deleted",
}

SAFE_PATH_COMPONENT_RE = re.compile(r"^[A-Za-z0-9._@+\-]+$")


def _log(msg: str) -> None:
    sys.stderr.write(f"imap-restore: {msg}\n")
    sys.stderr.flush()


def _maildir_flags(filename: str) -> frozenset[str]:
    m = MAILDIR_FLAG_RE.search(filename)
    if not m:
        return frozenset()
    return frozenset(
        MAILDIR_FLAG_TO_IMAP[c] for c in (m.group(1) or "") if c in MAILDIR_FLAG_TO_IMAP
    )


def _read_keyword_sidecar(message_path: str) -> frozenset[str]:
    """
    Read custom IMAP keywords from `<message-filename>.keywords` sidecar
    if present. Returns empty frozenset if missing (backwards-compat
    with maildirs produced before the sidecar was introduced, including
    the JMAP path's output).

    Sidecar format: one keyword per line, with the leading `\\` or `$`
    intact (e.g. `$Junk\\n$Forwarded\\n`).
    """
    sidecar = message_path + ".keywords"
    if not os.path.isfile(sidecar):
        return frozenset()
    try:
        with open(sidecar, "r", encoding="utf-8") as f:
            return frozenset(
                line.strip() for line in f if line.strip() and not line.startswith("#")
            )
    except OSError:
        return frozenset()


def _internal_date(unix_ts: int) -> str:
    """RFC 3501 INTERNALDATE format: `01-Jan-2026 12:00:00 +0000`."""
    return time.strftime("%d-%b-%Y %H:%M:%S +0000", time.gmtime(unix_ts))


def _maildir_internal_date(filename: str, fallback: float) -> str:
    head = filename.split(".", 1)[0]
    try:
        unix = int(head)
    except ValueError:
        unix = int(fallback)
    return _internal_date(unix)


def _parse_message_id(raw: bytes) -> str | None:
    """Extract RFC 5322 Message-ID from headers only (no full-body parse)."""
    try:
        parser = email.parser.BytesHeaderParser(policy=email.policy.default)
        msg = parser.parsebytes(raw)
        mid = msg.get("Message-ID")
        if mid is None:
            return None
        s = str(mid).strip()
        # Strip the < > brackets so we can pass to IMAP HEADER search
        # without re-escaping.
        if s.startswith("<") and s.endswith(">"):
            s = s[1:-1]
        return s
    except Exception:
        return None


def _enumerate_maildir(
    maildir_root: str, source_address: str
) -> list[tuple[str, str, frozenset[str], frozenset[str]]]:
    """
    Walk the maildir tree for `<source_address>`. Return a list of
    (imap_folder_name, file_path, system_flags, special_use) tuples.
    Also includes empty folders (file_path will be "" so caller can
    CREATE them without trying to APPEND).

    `imap_folder_name` is the ORIGINAL IMAP folder name from the
    server (e.g. "Sent Items"), read from `.imap-name` if present.
    Falls back to the path component (e.g. "Sent_Items") for older
    snapshots written before .imap-name was introduced.
    """
    src_safe = re.sub(r"[^A-Za-z0-9._@-]", "_", source_address)
    base = os.path.join(maildir_root, src_safe)
    if not os.path.isdir(base):
        _log(f"source address dir not found: {base}")
        return []

    out: list[tuple[str, str, frozenset[str], frozenset[str]]] = []
    for path_component in sorted(os.listdir(base)):
        if not SAFE_PATH_COMPONENT_RE.match(path_component):
            _log(f"skipping unsafe folder path: {path_component!r}")
            continue
        folder_dir = os.path.join(base, path_component)
        if not os.path.isdir(folder_dir):
            continue

        # Resolve the ORIGINAL IMAP folder name. Prefer .imap-name (new
        # snapshots); fall back to the sanitized path component for
        # legacy snapshots (which may have lost spaces / non-ASCII).
        imap_name = path_component
        name_marker = os.path.join(folder_dir, ".imap-name")
        if os.path.isfile(name_marker):
            try:
                with open(name_marker, encoding="utf-8") as f:
                    candidate = f.read().strip()
                    if candidate:
                        imap_name = candidate
            except OSError:
                pass

        # Read SPECIAL-USE marker if present.
        special_use: frozenset[str] = frozenset()
        marker = os.path.join(folder_dir, ".special-use")
        if os.path.isfile(marker):
            try:
                with open(marker) as f:
                    su = f.read().strip().split()
                    special_use = frozenset(su)
            except OSError:
                pass

        cur = os.path.join(folder_dir, "cur")
        files: list[str] = []
        if os.path.isdir(cur):
            files = sorted(os.listdir(cur))
        # Filter Maildir `.part` (in-flight writes) + dotfiles.
        files = [f for f in files if not f.startswith(".") and not f.endswith(".part")]

        if not files:
            out.append((imap_name, "", frozenset(), special_use))
            continue

        for fn in files:
            # Skip `.keywords` sidecar files at the enumeration stage —
            # they're consumed implicitly by `_read_keyword_sidecar`
            # alongside the parent .eml. (Sidecars don't have the
            # `:2,<flags>` Maildir suffix so MAILDIR_FLAG_RE rejects
            # them anyway, but the explicit skip avoids any future
            # filename-pattern surprises.)
            if fn.endswith(".keywords"):
                continue
            full = os.path.join(cur, fn)
            sys_flags = _maildir_flags(fn)
            extra = _read_keyword_sidecar(full)
            combined = sys_flags | extra
            out.append((imap_name, full, combined, special_use))
    return out


def _flush_literal_plus_batch(
    client: ImapClient,
    folder: str,
    batch: list[tuple[bytes, frozenset[str], str | None]],
) -> tuple[int, int]:
    """
    Send a LITERAL+ MULTIAPPEND batch. Returns (imported, failed).

    Failure-recovery strategy:
      1. Try LITERAL+ (fast path).
      2. If it fails, retry the whole batch with SYNC literals — SYNC
         eliminates the cumulative-buffer issue that trips Stalwart's
         maxRequestSize cap when LITERAL+ is used. Most LITERAL+
         failures recover here.
      3. If SYNC also fails, BISECT — recursively try each half. Two
         possible outcomes:
           - A single bad message in the batch (e.g. malformed RFC822
             or a size-cap edge case the per-msg pre-check missed) —
             bisection isolates it to a single-msg batch which fails
             alone, counted as 1 failure; the other N-1 good messages
             succeed.
           - Persistent server / connection error — bisection still
             terminates because batch size halves each retry; the worst
             case is O(log N) per-msg single APPENDs.
    """
    if not batch:
        return 0, 0
    try:
        client.multiappend(folder, batch, use_literal_plus=True)
        return len(batch), 0
    except ImapError as e:
        _log(f"LITERAL+ batch FAILED ({len(batch)} msgs into {folder!r}): {e}")
        try:
            _log(f"retrying batch SYNC for folder {folder!r}")
            client.multiappend(folder, batch, use_literal_plus=False)
            return len(batch), 0
        except ImapError as e2:
            if len(batch) == 1:
                _log(f"single-msg APPEND failed for {folder!r}, marking failed: {e2}")
                return 0, 1
            mid = len(batch) // 2
            _log(
                f"SYNC retry also failed for {folder!r}; bisecting "
                f"({len(batch)} → {mid}+{len(batch) - mid})"
            )
            ok1, bad1 = _flush_literal_plus_batch(client, folder, batch[:mid])
            ok2, bad2 = _flush_literal_plus_batch(client, folder, batch[mid:])
            return ok1 + ok2, bad1 + bad2


def _restore_folder_shard(
    client: ImapClient,
    folder: str,
    files: list[tuple[str, frozenset[str]]],
    *,
    dedup_message_ids: frozenset[str] | None,
) -> tuple[int, int, int, int]:
    """
    Restore one shard (subset) of a folder's messages on a single
    ImapClient. Returns (imported, skipped_dedup, skipped_oversize,
    failed).

    Each shard runs on its own connection (caller's responsibility);
    no state is shared with other shards beyond the read-only
    `dedup_message_ids` frozenset. The byte-budget batcher operates
    purely on the shard's local message stream.

    `dedup_message_ids` is the SHARED set of Message-IDs the caller
    confirmed exist on target (computed once on the main thread BEFORE
    workers spawn, then passed to every shard). None means dedup
    disabled. Frozenset enforces immutability across workers.
    """
    imported = 0
    skipped_dedup = 0
    skipped_oversize = 0
    failed = 0

    # Tag each file with its size so we can route by SOLO_SYNC_THRESHOLD.
    sized: list[tuple[str, frozenset[str], int, bytes | None]] = []
    for fpath, flags in files:
        try:
            sz = os.path.getsize(fpath)
        except OSError as e:
            _log(f"stat fail {fpath}: {e}; counting as failed")
            failed += 1
            continue
        sized.append((fpath, flags, sz, None))

    batch: list[tuple[bytes, frozenset[str], str | None]] = []
    batch_bytes = 0

    def flush() -> None:
        nonlocal imported, failed, batch, batch_bytes
        if not batch:
            return
        ok, bad = _flush_literal_plus_batch(client, folder, batch)
        imported += ok
        failed += bad
        batch = []
        batch_bytes = 0

    for fpath, flags, sz, _ in sized:
        # Read the body — needed for dedup-by-message-id and APPEND.
        try:
            with open(fpath, "rb") as f:
                body = f.read()
        except OSError as e:
            _log(f"read fail {fpath}: {e}")
            failed += 1
            continue

        # Oversize check first — cheap and avoids spending memory.
        if sz >= SKIP_THRESHOLD:
            _log(
                f"SKIP oversize: {fpath} size={sz} >= {SKIP_THRESHOLD} "
                "(over Stalwart per-literal cap)"
            )
            skipped_oversize += 1
            continue

        # Dedup-by-message-id if enabled.
        if dedup_message_ids is not None:
            mid = _parse_message_id(body[:8192])
            if mid and mid in dedup_message_ids:
                skipped_dedup += 1
                continue

        idate = _maildir_internal_date(os.path.basename(fpath), time.time())

        if sz >= SOLO_SYNC_THRESHOLD:
            # Big message — solo SYNC APPEND, bypass MULTIAPPEND batch.
            flush()  # flush anything queued first
            try:
                client.append_single_sync(folder, body, flags=flags, internal_date=idate)
                imported += 1
            except ImapError as e:
                _log(f"SOLO SYNC APPEND failed {fpath}: {e}")
                failed += 1
            continue

        # Small msg — pack into batch.
        if batch and (
            batch_bytes + sz > LITERAL_PLUS_BUDGET or len(batch) >= MAX_BATCH_COUNT
        ):
            flush()
        batch.append((body, flags, idate))
        batch_bytes += sz

    flush()
    return imported, skipped_dedup, skipped_oversize, failed


def _build_worker_pool(
    *,
    host: str,
    port: int,
    verify_tls: bool,
    login_user: str,
    password: str,
    workers: int,
    inter_login_delay_seconds: float = 0.2,
) -> list[ImapClient]:
    """
    Open K IMAP connections SEQUENTIALLY with a small delay between
    each LOGIN. Returns the LOGIN'd clients. Caller is responsible for
    closing them (caller will use try/finally + close()).

    Why sequential with delay:
      Stalwart 0.16 imposes a per-source rate limit on LOGINs that's
      not exposed in the `x:Imap` settings object — concurrent LOGINs
      from the same source pod trigger `NO [LIMIT] Too many concurrent
      requests` even with maxConcurrent=16 and per-user
      maxRequestRate set generously. Sequential LOGINs with a
      sub-second sleep between bypass this rate limit cleanly.

      Cost: K * inter_login_delay_seconds at startup. At K=4 and
      0.5s delay = 1.5s of upfront serial wait. Once workers are
      running, all subsequent IMAP commands run in parallel — the
      only serialization is the LOGIN handshake itself.
    """
    clients: list[ImapClient] = []
    try:
        for i in range(workers):
            c = ImapClient(host, port, verify_tls=verify_tls, on_log=_log)
            c.connect()
            c.login(login_user, password)
            c.enable("UTF8=ACCEPT")
            clients.append(c)
            if i + 1 < workers and inter_login_delay_seconds > 0:
                time.sleep(inter_login_delay_seconds)
    except Exception:
        # If any LOGIN fails mid-build, close the ones already opened
        # to avoid leaking sockets on the source side.
        for c in clients:
            try:
                c.close()
            except Exception:
                pass
        raise
    return clients


def _restore_folder_parallel(
    *,
    clients: list[ImapClient],
    folder: str,
    files: list[tuple[str, frozenset[str]]],
    dedup_message_ids: frozenset[str] | None,
) -> tuple[int, int, int, int]:
    """
    Run `_restore_folder_shard` across len(clients) worker threads.
    Returns the aggregated
    (imported, skipped_dedup, skipped_oversize, failed) tuple.

    Sharding: messages are split modulo K so each worker handles
    `files[k::K]`. This preserves rough chronological order (files come
    in already sorted by filename, which embeds the Maildir timestamp
    prefix) and requires no shared state — each worker manages its
    own byte-budget batcher independently.

    Connection lifecycle: the `clients` list is owned by the CALLER —
    each connection is reused across multiple folder restores (one
    LOGIN per restore Job, not per folder). Workers SELECT the target
    folder writable at the start of each shard call.

    Dedup set: caller built the frozenset ONCE on the main thread
    before this fn was called. Workers read-only consume it; no
    redundant FETCH 1:* BODY.PEEK[] per worker.

    Errors: each worker's exception is caught and reported as failed
    count for its shard. A single worker crash does not abort the
    others.
    """
    workers = len(clients)
    if workers < 1:
        return 0, 0, 0, 0

    totals = {
        "imported": 0,
        "skipped_dedup": 0,
        "skipped_oversize": 0,
        "failed": 0,
    }
    totals_lock = threading.Lock()

    def _worker(shard_idx: int, client: ImapClient, shard: list[tuple[str, frozenset[str]]]) -> None:
        if not shard:
            return
        try:
            client.select(folder, readonly=False)
            fi, fd, fo, ff = _restore_folder_shard(
                client,
                folder,
                shard,
                dedup_message_ids=dedup_message_ids,
            )
            with totals_lock:
                totals["imported"] += fi
                totals["skipped_dedup"] += fd
                totals["skipped_oversize"] += fo
                totals["failed"] += ff
        except (ImapError, OSError) as e:
            _log(
                f"worker {shard_idx}/{workers} crashed mid-shard "
                f"({len(shard)} files) on folder {folder!r}: {e}"
            )
            with totals_lock:
                totals["failed"] += len(shard)

    # Modulo-K sharding. Slicing `files[k::workers]` is O(N/K) per
    # worker and preserves chronological order within a shard.
    shards = [files[k::workers] for k in range(workers)]
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="imap-restore") as pool:
        # Pair each worker thread with its OWN pre-LOGIN'd client.
        list(pool.map(
            lambda triple: _worker(*triple),
            zip(range(workers), clients, shards),
        ))

    return (
        totals["imported"],
        totals["skipped_dedup"],
        totals["skipped_oversize"],
        totals["failed"],
    )


def _collect_existing_message_ids(client: ImapClient, folder: str) -> set[str]:
    """
    Return the set of Message-IDs already in `folder` on the target.
    Used for merge-skip-duplicates. We do `UID SEARCH HEADER MESSAGE-ID *`
    is not portable; instead enumerate UIDs and FETCH each. To keep this
    cheap, we cap at 50k message IDs per folder — beyond that the dedup
    pass is more expensive than just letting duplicates happen.
    """
    try:
        client.select(folder, readonly=True)
    except ImapError as e:
        _log(f"dedup: cannot SELECT {folder!r}: {e}")
        return set()
    uids: list[int] = []
    try:
        uids = client.uid_search("ALL")
    except ImapError as e:
        _log(f"dedup: UID SEARCH failed in {folder!r}: {e}")
        return set()
    if not uids:
        return set()
    if len(uids) > 50_000:
        _log(
            f"dedup: {folder!r} has {len(uids)} msgs (>50k); skipping dedup "
            "for this folder — falling back to no-dedup for it."
        )
        return set()
    # Re-using fetch_all_bodies pulls full bodies which is wasteful for
    # dedup. For v1 we accept the cost; v2 follow-up: implement
    # FETCH 1:* BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)] which streams only
    # headers.
    out: set[str] = set()
    for _uid, _flags, body in client.fetch_all_bodies():
        mid = _parse_message_id(body[:8192])
        if mid:
            out.add(mid)
    return out


def _replace_mode_purge(client: ImapClient, folder: str) -> int:
    """STORE +FLAGS \\Deleted on all messages then EXPUNGE. Returns count purged."""
    try:
        status = client.select(folder, readonly=False)
    except ImapError as e:
        _log(f"replace mode: cannot SELECT {folder!r} writable: {e}")
        return 0
    n = status.get("EXISTS", 0)
    if n == 0:
        return 0
    try:
        client.store_deleted("1:*")
        client.expunge()
        return n
    except ImapError as e:
        _log(f"replace mode purge of {folder!r} failed: {e}")
        return 0


def run(args: argparse.Namespace) -> int:
    pw = os.environ.get(args.auth_pass_env, "")
    if not pw:
        _log(f"env {args.auth_pass_env!r} is empty")
        return 2

    auth_user = f"{args.target_address}%{args.master_user}"
    t_start = time.time()
    imported = 0
    skipped_dedup = 0
    skipped_oversize = 0
    failed = 0
    mailboxes_created: list[str] = []

    files = _enumerate_maildir(args.maildir_root, args.source_address)
    _log(
        f"source={args.source_address} target={args.target_address} "
        f"entries={len(files)} mode={args.mode}"
    )
    if not files:
        sys.stdout.write(json.dumps({
            "address": args.target_address,
            "imported": 0,
            "skipped": 0,
            "failed": 0,
            "mailboxesCreated": [],
            "elapsedSeconds": 0.0,
            "engine": "imap",
        }) + "\n")
        return 0

    # Group by folder for batching efficiency.
    by_folder: dict[str, list[tuple[str, frozenset[str]]]] = {}
    special_use_by_folder: dict[str, frozenset[str]] = {}
    for folder_name, fpath, flags, special_use in files:
        special_use_by_folder.setdefault(folder_name, special_use)
        if fpath:
            by_folder.setdefault(folder_name, []).append((fpath, flags))
        else:
            by_folder.setdefault(folder_name, [])  # ensure CREATE-only entry

    # Build the worker pool up front. K connections, sequentially
    # LOGIN'd with a small inter-LOGIN delay to bypass Stalwart's
    # per-source LOGIN rate limit. The connections live for the
    # entire restore — one LOGIN per Job, not per folder.
    # K=1 just builds one connection — the sequential path uses it
    # the same way the parallel path uses K of them.
    try:
        pool = _build_worker_pool(
            host=args.imap_host,
            port=args.imap_port,
            verify_tls=args.verify_tls,
            login_user=auth_user,
            password=pw,
            workers=max(1, args.workers),
        )
    except ImapError as e:
        _log(f"fatal: worker pool LOGIN failed: {e}")
        return 2
    except OSError as e:
        _log(f"fatal: worker pool connect failed: {e}")
        return 3

    try:
        # The first client in the pool is the "main" for read-only ops
        # like LIST, dedup pass, replace-mode purge. Workers share the
        # full pool for parallel APPENDs.
        client = pool[0]
        existing: dict[str, FolderInfo] = {
            f.name: f for f in client.list_folders()
        }

        for folder_name in sorted(by_folder):
            if folder_name not in existing:
                try:
                    client.create_folder(
                        folder_name,
                        special_use=special_use_by_folder.get(folder_name) or None,
                    )
                    mailboxes_created.append(folder_name)
                    _log(f"created folder {folder_name!r}")
                except ImapError as e:
                    _log(f"CREATE {folder_name!r} failed: {e}; skipping its msgs")
                    failed += len(by_folder[folder_name])
                    continue

            folder_files = by_folder[folder_name]
            if not folder_files:
                continue  # empty-folder entry — just CREATE

            # replace mode: wipe target folder BEFORE importing (main thread)
            if args.mode == "replace":
                purged = _replace_mode_purge(client, folder_name)
                if purged:
                    _log(f"replace mode purged {purged} from {folder_name!r}")

            # dedup pass for merge-skip-duplicates (main thread, once)
            dedup_ids: set[str] | None = None
            if args.mode == "merge-skip-duplicates":
                dedup_ids = _collect_existing_message_ids(client, folder_name)
                _log(
                    f"dedup: {folder_name!r} has {len(dedup_ids)} existing "
                    "message-ids on target"
                )

            # Freeze the dedup set for safe sharing across workers.
            dedup_frozen: frozenset[str] | None = (
                frozenset(dedup_ids) if dedup_ids is not None else None
            )

            if args.workers <= 1:
                # Sequential path — re-use the main thread's client.
                try:
                    client.select(folder_name, readonly=False)
                except ImapError as e:
                    _log(f"SELECT writable {folder_name!r} failed: {e}; skipping")
                    failed += len(folder_files)
                    continue
                fi, fd, fo, ff = _restore_folder_shard(
                    client,
                    folder_name,
                    folder_files,
                    dedup_message_ids=dedup_frozen,
                )
            else:
                # Parallel path — K worker threads, each on its own
                # pre-LOGIN'd connection. Files are sharded modulo K.
                fi, fd, fo, ff = _restore_folder_parallel(
                    clients=pool,
                    folder=folder_name,
                    files=folder_files,
                    dedup_message_ids=dedup_frozen,
                )
            imported += fi
            skipped_dedup += fd
            skipped_oversize += fo
            failed += ff
            _log(
                f"folder={folder_name!r} workers={args.workers} "
                f"imported={fi} skipped_dedup={fd} "
                f"skipped_oversize={fo} failed={ff}"
            )

    except ImapError as e:
        _log(f"fatal IMAP error: {e}")
        return 2
    except OSError as e:
        _log(f"fatal I/O error: {e}")
        return 3
    finally:
        # Best-effort close of every pool connection. close() sends
        # LOGOUT + closes the socket; on a healthy run all K workers
        # have already returned and the connections are idle.
        for c in pool:
            try:
                c.close()
            except Exception:
                pass

    elapsed = round(time.time() - t_start, 2)
    summary: dict[str, Any] = {
        "address": args.target_address,
        "imported": imported,
        "skipped": skipped_dedup + skipped_oversize,
        "skippedDedup": skipped_dedup,
        "skippedOversize": skipped_oversize,
        "failed": failed,
        "mailboxesCreated": mailboxes_created,
        "elapsedSeconds": elapsed,
        "engine": "imap",
    }
    sys.stdout.write(json.dumps(summary) + "\n")
    sys.stdout.flush()
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="IMAP MULTIAPPEND restore for tenant-bundles (replaces jmap-restore.py)"
    )
    p.add_argument("--imap-host", required=True, help="Stalwart IMAP host")
    p.add_argument("--imap-port", type=int, default=993)
    p.add_argument(
        "--target-address",
        required=True,
        help="Account to restore INTO (e.g. user@new-tenant.example)",
    )
    p.add_argument(
        "--source-address",
        required=True,
        help="Account label inside the maildir snapshot tree",
    )
    p.add_argument(
        "--master-user",
        required=True,
        help="Master principal FQ (e.g. master@master.local)",
    )
    p.add_argument(
        "--auth-pass-env",
        required=True,
        help="Env-var name holding the master principal's password",
    )
    p.add_argument(
        "--maildir-root",
        required=True,
        help="Root of the Maildir snapshot tree (contains <source-address>/...)",
    )
    p.add_argument(
        "--mode",
        choices=("merge-skip-duplicates", "merge-overwrite", "replace"),
        default="merge-skip-duplicates",
        help="Restore conflict-resolution policy. Default skips duplicates.",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=4,
        help=(
            "Parallel IMAP connections per restore Job (default 4 — symmetric "
            "with the JMAP path's worker count). Each worker opens its own "
            "connection + LOGIN, then operates on a modulo-K shard of the "
            "message list. Capped server-side by x:Imap.maxConcurrent "
            "(default 16). Set to 1 to fall back to the original "
            "single-connection sequential restore."
        ),
    )
    p.add_argument(
        "--verify-tls",
        action="store_true",
        help="Verify Stalwart's TLS certificate (default off for cluster-internal).",
    )
    args = p.parse_args(argv)
    if args.workers < 1 or args.workers > 32:
        p.error(f"--workers must be in [1, 32] (got {args.workers})")
    return args


if __name__ == "__main__":
    sys.exit(run(_parse_args()))
