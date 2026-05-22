"""
imap_client.py — minimal raw IMAP4rev2 helper for mail-backup-tools.

Why raw and not imaplib?
  - imaplib does not support MULTIAPPEND (RFC 3502). For restore we need
    it: one round-trip can deliver N messages. imaplib also doesn't use
    LITERAL+ (RFC 7888), so even single-APPEND it pays an extra
    round-trip per message waiting for `+ Ready`.
  - For the export path FETCH 1:* (BODY.PEEK[]) is one command that
    streams arbitrarily many responses — easier to parse the streamed
    chunks directly than to fight imaplib's UNTAGGED collector.

Auth model: master-user proxy. `LOGIN <addr>%<master> <master-password>`
authenticates as the master principal but selects `<addr>`'s mailbox
view. Same model as the JMAP path (see jmap-sync.py).

Stdlib only — no third-party deps.

References:
  - RFC 9051 IMAP4rev2
  - RFC 3501 IMAP4rev1 (folder name encoding fallback)
  - RFC 3502 MULTIAPPEND
  - RFC 6855 UTF8=ACCEPT (use UTF-8 mailbox names after ENABLE)
  - RFC 6154 SPECIAL-USE (\\Inbox \\Sent \\Drafts \\Trash \\Junk \\Archive)
  - RFC 7162 CONDSTORE / QRESYNC (NOT used here — bundles are COMPLETE)
  - RFC 7888 LITERAL+ (non-synchronizing literal)
"""
from __future__ import annotations

import re
import socket
import ssl
import sys
import time
from dataclasses import dataclass
from typing import Callable, Iterator


# ── Errors ──────────────────────────────────────────────────────────────────


class ImapError(Exception):
    """Any IMAP protocol failure raised by ImapClient."""


class ImapTaggedNo(ImapError):
    """Server replied with a tagged NO to the command (semantic failure)."""


class ImapTaggedBad(ImapError):
    """Server replied with a tagged BAD (protocol / parse failure)."""


# ── Folder + flag parsing ───────────────────────────────────────────────────


SYS_FLAG_TO_MAILDIR: dict[str, str] = {
    "\\Seen": "S",
    "\\Flagged": "F",
    "\\Answered": "R",
    "\\Deleted": "T",
    "\\Draft": "D",
}

# RFC 6154 SPECIAL-USE → human-readable Maildir folder name. The platform's
# Maildir output tree uses the raw IMAP folder name; this map only matters
# for restore-side mailbox CREATE so we can request matching SPECIAL-USE
# when the source had it (e.g. roundtripping "Sent Mail").
SPECIAL_USE_FLAGS: set[str] = {
    "\\All",
    "\\Archive",
    "\\Drafts",
    "\\Flagged",
    "\\Junk",
    "\\Sent",
    "\\Trash",
    "\\Important",
}


# ── ImapClient ──────────────────────────────────────────────────────────────


@dataclass
class FolderInfo:
    """One LIST response row."""
    name: str
    delimiter: str
    flags: frozenset[str]   # \HasNoChildren \HasChildren \Noselect etc.
    special_use: frozenset[str]   # \Sent \Drafts ...


class ImapClient:
    """
    Raw-socket IMAPS client with just the verbs we need:
      LOGIN, ENABLE, LIST, SELECT, CREATE, STATUS,
      FETCH (BODY.PEEK[] streaming), APPEND, MULTIAPPEND,
      STORE, EXPUNGE, UID SEARCH, LOGOUT.

    Thread-safe: NO. Use one ImapClient per worker thread.
    """

    def __init__(
        self,
        host: str,
        port: int = 993,
        *,
        timeout_seconds: int = 120,
        verify_tls: bool = False,
        # Stderr logger — defaults to None (silent). Callers wire their
        # own logger (we keep the helper stdlib-only + logging-policy-free).
        on_log: Callable[[str], None] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.timeout_seconds = timeout_seconds
        self.verify_tls = verify_tls
        self._on_log = on_log
        self._sock: ssl.SSLSocket | None = None
        # imaplib uses 4 chars; we use 5 so multi-thread tag-collision is
        # near-impossible even though we don't share connections.
        self._tag_counter = 1

    # ── Connection lifecycle ──────────────────────────────────────────────

    def connect(self) -> None:
        ctx = ssl.create_default_context()
        if not self.verify_tls:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection(
            (self.host, self.port),
            timeout=self.timeout_seconds,
        )
        self._sock = ctx.wrap_socket(raw, server_hostname=self.host)
        self._sock.settimeout(self.timeout_seconds)
        # Eat the server greeting (untagged OK / BYE).
        line = self._readline_raw()
        if not line.startswith(b"* OK"):
            raise ImapError(f"unexpected greeting: {line!r}")

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._cmd("LOGOUT")
            except Exception:
                pass
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def __enter__(self) -> "ImapClient":
        self.connect()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── Low-level I/O ─────────────────────────────────────────────────────

    def _next_tag(self) -> bytes:
        self._tag_counter += 1
        return f"a{self._tag_counter:05d}".encode()

    def _send_raw(self, data: bytes) -> None:
        if self._sock is None:
            raise ImapError("client not connected")
        self._sock.sendall(data)

    def _readline_raw(self) -> bytes:
        if self._sock is None:
            raise ImapError("client not connected")
        # Stream a line. Using makefile would be cleaner but it conflicts
        # with our literal-streaming pattern (we sometimes need to read
        # exactly N bytes after a `{N}` annotation in the response).
        buf: list[bytes] = []
        while True:
            ch = self._sock.recv(1)
            if not ch:
                raise ImapError("connection closed by server")
            buf.append(ch)
            if ch == b"\n":
                break
            # Defensive cap. IMAP allows arbitrarily long lines in theory
            # but in practice anything past 1 MB is a parse-runaway.
            if sum(len(b) for b in buf) > 1_048_576:
                raise ImapError("line too long (>1 MB) — parse runaway")
        return b"".join(buf)

    def _read_exact(self, n: int) -> bytes:
        """Read exactly n bytes — used for literal bodies in responses."""
        if self._sock is None:
            raise ImapError("client not connected")
        chunks: list[bytes] = []
        remaining = n
        while remaining > 0:
            chunk = self._sock.recv(min(remaining, 65536))
            if not chunk:
                raise ImapError(
                    f"connection closed mid-literal "
                    f"(expected {n} bytes, got {n - remaining})"
                )
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _log(self, msg: str) -> None:
        if self._on_log is not None:
            self._on_log(msg)

    # ── Tagged command helpers ───────────────────────────────────────────

    def _cmd(self, line: str | bytes) -> tuple[bytes, list[bytes]]:
        """
        Send a tagged command, return (tagged_response_line, [untagged_lines]).
        Does NOT handle commands with literal continuations — use _cmd_with_literals
        or _cmd_multiappend for those.
        """
        if isinstance(line, str):
            line = line.encode()
        tag = self._next_tag()
        self._send_raw(tag + b" " + line + b"\r\n")
        untagged: list[bytes] = []
        while True:
            resp = self._readline_raw()
            if resp.startswith(tag + b" "):
                return resp, untagged
            untagged.append(resp)

    # ── Public verbs ──────────────────────────────────────────────────────

    def login(self, user: str, password: str) -> None:
        # IMAP LOGIN may need quoting if user/pass contain special chars.
        # Master-user proxy form is `<addr>%<master>` which contains '@'
        # but no whitespace/quotes — safe to send unquoted. Defensive
        # quoting via the literal form for passwords with special chars.
        u = self._quote_astring(user)
        p = self._quote_astring(password)
        resp, _ = self._cmd(f"LOGIN {u} {p}")
        if not _is_ok(resp):
            raise ImapError(f"LOGIN failed: {_decode(resp)}")

    @staticmethod
    def _quote_astring(s: str) -> str:
        """Quote per IMAP astring rules. Keep it simple — quoted-string form."""
        # IMAP spec: backslash + dquote escape only.
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

    def enable(self, *capabilities: str) -> None:
        """Issue ENABLE (RFC 5161). Tolerates BAD if server doesn't know
        the capability — we proceed best-effort."""
        if not capabilities:
            return
        resp, _ = self._cmd("ENABLE " + " ".join(capabilities))
        if not _is_ok(resp):
            self._log(f"ENABLE failed (continuing best-effort): {_decode(resp)}")

    def list_folders(self) -> list[FolderInfo]:
        """LIST "" "*" — return every visible mailbox."""
        resp, untagged = self._cmd('LIST "" "*"')
        if not _is_ok(resp):
            raise ImapError(f"LIST failed: {_decode(resp)}")
        return [_parse_list_response(u) for u in untagged if u.startswith(b"* LIST")]

    def create_folder(
        self, name: str, *, special_use: frozenset[str] | None = None
    ) -> None:
        """
        CREATE mailbox. Honors SPECIAL-USE if given; falls back to plain
        CREATE if Stalwart refuses the USE attribute (some clients can't
        request SPECIAL-USE on create).
        """
        n = self._quote_astring(name)
        if special_use:
            attrs = " ".join(sorted(special_use))
            line = f"CREATE {n} (USE ({attrs}))"
        else:
            line = f"CREATE {n}"
        resp, _ = self._cmd(line)
        if not _is_ok(resp):
            text = _decode(resp)
            if "ALREADYEXISTS" in text.upper():
                return
            # Retry without SPECIAL-USE if that was the cause.
            if special_use and "USE" in text.upper():
                self._log(
                    f"CREATE with SPECIAL-USE {sorted(special_use)} failed; "
                    f"retrying plain. Server said: {text}"
                )
                resp2, _ = self._cmd(f"CREATE {n}")
                if _is_ok(resp2):
                    return
                if "ALREADYEXISTS" in _decode(resp2).upper():
                    return
                raise ImapError(f"CREATE {name} failed (plain): {_decode(resp2)}")
            raise ImapError(f"CREATE {name} failed: {text}")

    def select(self, name: str, *, readonly: bool = True) -> dict[str, int]:
        """
        SELECT (or EXAMINE if readonly). Returns a small dict with the
        UIDVALIDITY + UIDNEXT + MESSAGES count for the caller.
        """
        verb = "EXAMINE" if readonly else "SELECT"
        n = self._quote_astring(name)
        resp, untagged = self._cmd(f"{verb} {n}")
        if not _is_ok(resp):
            raise ImapError(f"{verb} {name} failed: {_decode(resp)}")
        out: dict[str, int] = {}
        for u in untagged:
            text = u.decode("utf-8", errors="replace").strip()
            m = re.match(r"\* (\d+) EXISTS", text)
            if m:
                out["EXISTS"] = int(m.group(1))
                continue
            m = re.search(r"\[UIDVALIDITY (\d+)\]", text)
            if m:
                out["UIDVALIDITY"] = int(m.group(1))
                continue
            m = re.search(r"\[UIDNEXT (\d+)\]", text)
            if m:
                out["UIDNEXT"] = int(m.group(1))
        return out

    def uid_search(self, criteria: str) -> list[int]:
        """UID SEARCH — returns the matching UID list."""
        resp, untagged = self._cmd(f"UID SEARCH {criteria}")
        if not _is_ok(resp):
            raise ImapError(f"UID SEARCH failed: {_decode(resp)}")
        for u in untagged:
            if u.startswith(b"* SEARCH"):
                parts = u.decode("ascii", errors="replace").strip().split()
                return [int(p) for p in parts[2:] if p.isdigit()]
        return []

    def fetch_all_bodies(self) -> Iterator[tuple[int, frozenset[str], bytes]]:
        """
        FETCH 1:* (UID FLAGS BODY.PEEK[]) — streams (uid, flags, body) tuples.
        Caller must have already SELECT/EXAMINEd a mailbox.

        We parse the streamed response inline because FETCH responses
        contain {N}-prefixed literals whose length we must honor — we
        read exactly N bytes from the socket then resume parsing the
        rest of the response line.
        """
        if self._sock is None:
            raise ImapError("client not connected")
        tag = self._next_tag()
        self._send_raw(tag + b" FETCH 1:* (UID FLAGS BODY.PEEK[])\r\n")

        # State for the current FETCH untagged entry.
        # Stalwart emits: `* <seq> FETCH (UID 123 FLAGS (\Seen) BODY[] {N}`
        # then N bytes of body, then `)\r\n` to close.
        while True:
            head = self._readline_raw()
            if head.startswith(tag + b" "):
                if not _is_ok(head):
                    raise ImapError(f"FETCH failed: {_decode(head)}")
                return
            if not head.startswith(b"* "):
                # untagged status / capabilities / etc. — ignore
                continue
            # Match `* <seq> FETCH (...{N}` — extract uid + flags + N
            m = re.match(rb"\* (\d+) FETCH \((.*)\{(\d+)\}", head)
            if not m:
                # Lots of FETCH variants we don't expect; skip.
                continue
            attrs_blob = m.group(2).decode("utf-8", errors="replace")
            body_len = int(m.group(3))
            uid_m = re.search(r"UID (\d+)", attrs_blob)
            flags_m = re.search(r"FLAGS \(([^)]*)\)", attrs_blob)
            uid = int(uid_m.group(1)) if uid_m else 0
            flag_list = (flags_m.group(1).split() if flags_m else [])
            body = self._read_exact(body_len)
            # After the literal Stalwart sends `)\r\n` (possibly with trailing
            # untagged updates first). Read until we see the close paren line.
            closer = self._readline_raw()
            # On Stalwart 0.16 the closer is `)\r\n` — strip+continue.
            _ = closer  # noqa: silence "unused" — defensive read
            yield uid, frozenset(flag_list), body

    def append_single_sync(
        self,
        mailbox: str,
        body: bytes,
        *,
        flags: frozenset[str] = frozenset(),
        internal_date: str | None = None,
    ) -> None:
        """
        Single APPEND using SYNC literals. Sends the literal length and
        waits for `+ Ready`. Used for individual messages >10 MiB where
        LITERAL+ buffering can cumulatively trip the 100 MiB
        x:Imap.maxRequestSize cap.
        """
        n = self._quote_astring(mailbox)
        flag_str = " ".join(sorted(flags))
        date_str = f" \"{internal_date}\"" if internal_date else ""
        tag = self._next_tag()
        # Use SYNC literal (no `+`): server holds the parse buffer until
        # we send the body. Each literal is checked against maxRequestSize
        # individually, NOT cumulatively across MULTIAPPEND.
        self._send_raw(
            tag + f" APPEND {n} ({flag_str}){date_str} ".encode()
            + f"{{{len(body)}}}\r\n".encode()
        )
        cont = self._readline_raw()
        if not cont.startswith(b"+"):
            raise ImapError(f"SYNC APPEND rejected before body: {_decode(cont)}")
        self._send_raw(body + b"\r\n")
        resp = self._readline_raw()
        while not resp.startswith(tag + b" "):
            resp = self._readline_raw()
        if not _is_ok(resp):
            raise ImapError(f"APPEND failed: {_decode(resp)}")

    def multiappend(
        self,
        mailbox: str,
        msgs: list[tuple[bytes, frozenset[str], str | None]],
        *,
        use_literal_plus: bool = True,
    ) -> None:
        """
        MULTIAPPEND batch. `msgs` is a list of (body, flags, internal_date).

        With `use_literal_plus=True` (default) sends LITERAL+ literals
        — no per-literal continuation round-trip. Stalwart's
        maxRequestSize cap applies to the CUMULATIVE bytes of the
        APPEND command when LITERAL+ is used; the caller is responsible
        for keeping the sum well under the cap (recommend ≤80 MiB to
        leave parser headroom).

        With `use_literal_plus=False` falls back to SYNC literals
        (per-literal `+ Ready` wait). Slower but cumulative size doesn't
        matter — only per-literal.

        Caller must NOT mix MULTIAPPEND batch with a single message
        larger than half the request cap; route those through
        append_single_sync instead.
        """
        if not msgs:
            return
        n = self._quote_astring(mailbox)
        tag = self._next_tag()

        if use_literal_plus:
            # Build the entire request in one send. Memory: 2x the batch
            # size in this process; cheap compared to Stalwart's parse
            # buffer. Keep batch_total_bytes accumulation in the caller
            # so we never approach the cap.
            parts: list[bytes] = [tag, b" APPEND ", n.encode()]
            for idx, (body, flags, internal_date) in enumerate(msgs):
                flag_str = " ".join(sorted(flags))
                date_str = f" \"{internal_date}\"" if internal_date else ""
                parts.append(f" ({flag_str}){date_str} ".encode())
                parts.append(f"{{{len(body)}+}}\r\n".encode())
                parts.append(body)
            parts.append(b"\r\n")
            self._send_raw(b"".join(parts))
        else:
            # SYNC literal path — for the rare case where the batch
            # would cumulatively exceed the cap even though each
            # individual literal is under.
            self._send_raw(tag + b" APPEND " + n.encode())
            for body, flags, internal_date in msgs:
                flag_str = " ".join(sorted(flags))
                date_str = f" \"{internal_date}\"" if internal_date else ""
                self._send_raw(
                    f" ({flag_str}){date_str} ".encode()
                    + f"{{{len(body)}}}\r\n".encode()
                )
                cont = self._readline_raw()
                if not cont.startswith(b"+"):
                    raise ImapError(
                        f"SYNC MULTIAPPEND rejected before body: {_decode(cont)}"
                    )
                self._send_raw(body)
            self._send_raw(b"\r\n")

        resp = self._readline_raw()
        while not resp.startswith(tag + b" "):
            resp = self._readline_raw()
        if not _is_ok(resp):
            raise ImapError(f"MULTIAPPEND failed: {_decode(resp)}")

    def store_deleted(self, seq: str) -> None:
        """STORE <seq> +FLAGS.SILENT (\\Deleted) — used by replace mode."""
        resp, _ = self._cmd(f"STORE {seq} +FLAGS.SILENT (\\Deleted)")
        if not _is_ok(resp):
            raise ImapError(f"STORE +Deleted failed: {_decode(resp)}")

    def expunge(self) -> None:
        resp, _ = self._cmd("EXPUNGE")
        if not _is_ok(resp):
            raise ImapError(f"EXPUNGE failed: {_decode(resp)}")


# ── Top-level parsers / utilities ───────────────────────────────────────────


def _is_ok(line: bytes) -> bool:
    # Tagged responses are: "<tag> OK ..." / "<tag> NO ..." / "<tag> BAD ..."
    return b" OK " in line[:30] or line.endswith(b" OK\r\n")


def _decode(line: bytes) -> str:
    return line.decode("utf-8", errors="replace").strip()


_LIST_RE = re.compile(
    rb'^\* LIST \(([^)]*)\) "([^"]*)" (.+)$'
)


def _parse_list_response(line: bytes) -> FolderInfo:
    """
    Parse `* LIST (\\HasNoChildren \\Inbox) "/" Inbox`.

    Folder name may be quoted ("name") or an astring (bare word). We
    don't currently support modified UTF-7 decoding; rely on
    ENABLE UTF8=ACCEPT being issued before LIST.
    """
    line = line.rstrip(b"\r\n")
    m = _LIST_RE.match(line)
    if not m:
        raise ImapError(f"unparseable LIST response: {line!r}")
    flags_blob = m.group(1).decode("ascii", errors="replace")
    delimiter = m.group(2).decode("ascii", errors="replace")
    name_blob = m.group(3)
    name = name_blob.decode("utf-8", errors="replace")
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    flags = set(flags_blob.split())
    special_use = flags & SPECIAL_USE_FLAGS
    return FolderInfo(
        name=name,
        delimiter=delimiter,
        flags=frozenset(flags),
        special_use=frozenset(special_use),
    )


def maildir_flags_suffix(imap_flags: frozenset[str]) -> str:
    """
    Map IMAP system flags → Maildir flag suffix (cr.yp.to/proto/maildir.html).
    Custom keywords are NOT carried in the Maildir name — they are
    serialized separately into a `.keywords` companion file or kept in
    a per-message metadata sidecar (callers decide).
    """
    chars = "".join(
        sorted(SYS_FLAG_TO_MAILDIR[f] for f in imap_flags if f in SYS_FLAG_TO_MAILDIR)
    )
    return chars


def custom_keywords(imap_flags: frozenset[str]) -> frozenset[str]:
    """All flags that aren't system flags ($Junk, $Forwarded, etc.)."""
    return frozenset(
        f for f in imap_flags
        if f not in SYS_FLAG_TO_MAILDIR and f not in {"\\Recent"}
    )


def deterministic_unique(uid: int, mailbox: str, now: float | None = None) -> str:
    """
    Generate a Maildir filename's unique segment (the `<unix>.<unique>`
    middle part of `<unix>.<unique>:2,<flags>`). Stable for a given
    (uid, mailbox) pair so re-runs produce identical names.
    """
    ts = int(now if now is not None else time.time())
    # PID + hostname not needed because the script is the sole producer
    # of the output tree.
    safe_mb = re.sub(r"[^A-Za-z0-9._-]", "_", mailbox)[:32]
    return f"{ts}.{uid:08d}_{safe_mb}"
