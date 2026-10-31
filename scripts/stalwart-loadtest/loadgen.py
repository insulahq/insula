#!/usr/bin/env python3
"""loadgen.py — mail-store load generator for the Stalwart v1 evaluation (ADR-065).

Standard library only, so it runs in a stock python image. Every command prints one JSON
document on stdout (the measurement) and progress on stderr.

The corpus is deterministic: message number g is always the same bytes, whichever server
or store receives it, so every variant is loaded with an identical corpus.

  setup-bootstrap  apply x:Bootstrap (server in bootstrap mode, empty store)
  setup-configure  domain, listeners, limits, allowed IPs and the test accounts
  admin            one admin JMAP request (JSON method calls on stdin)
  append           load the corpus over IMAP APPEND (store-bound ingest)
  smtp             deliver messages over SMTP port 25, then wait until all are stored
  imap-read        timed mix of IMAP reads and flag writes
  jmap-read        timed mix of JMAP list / open / search / keyword writes
  big              one-off operations on the large mailbox
  mixed            SMTP at a fixed rate plus IMAP and JMAP readers, at the same time
  delete           delete a fraction of every mailbox (STORE \\Deleted + EXPUNGE)
  idle-probe       deliver to one server, time the IMAP IDLE notice on another
  sample           UIDVALIDITY, UIDs and body hashes of a fixed message sample
  compare          compare two `sample` outputs (migration check)
  counts           messages per account

Environment: LT_HOST (server), LT_DOMAIN, LT_USER_PASSWORD, LT_ADMIN_USER,
LT_ADMIN_PASSWORD, LT_SEED.
"""
import argparse
import base64
import datetime
import hashlib
import http.client
import imaplib
import json
import math
import os
import random
import smtplib
import ssl
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

DOMAIN = os.environ.get("LT_DOMAIN", "loadtest.example.test")
HOST = os.environ.get("LT_HOST", "lt-stalwart")
SEED = int(os.environ.get("LT_SEED", "65"))
JMAP_PORT = int(os.environ.get("LT_JMAP_PORT", "8080"))
BASE_DATE = datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc)
BIG_ACCOUNT = "big"

imaplib._MAXLINE = 50_000_000  # FETCH 1:* FLAGS on a large mailbox is one long response
TLS = ssl.create_default_context()
TLS.check_hostname = False
TLS.verify_mode = ssl.CERT_NONE  # the test server has a self-signed certificate


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def user_password():
    return os.environ["LT_USER_PASSWORD"]


def account_names(n):
    return [f"u{i:03d}" for i in range(n)]


def address(name):
    return f"{name}@{DOMAIN}"


# ── corpus ─────────────────────────────────────────────────────────────────────────

def _vocabulary():
    rng = random.Random(SEED)
    syll = ["ka", "lo", "mi", "ne", "su", "ta", "ri", "po", "ve", "do", "an", "el", "is", "or",
            "um", "ba", "ce", "fi", "gu", "ha", "jo", "ku", "ly", "my", "ny", "pe", "qu", "ro"]
    words = set()
    while len(words) < 4000:
        words.add("".join(rng.choice(syll) for _ in range(rng.randint(1, 4))))
    words = sorted(words)
    rng.shuffle(words)
    weights = [1.0 / (rank + 1) for rank in range(len(words))]  # Zipf-like, as real text
    cum, total = [], 0.0
    for w in weights:
        total += w
        cum.append(total)
    return words, cum


VOCAB, VOCAB_CUM = _vocabulary()


def _text(rng, n_words, rare):
    words = rng.choices(VOCAB, cum_weights=VOCAB_CUM, k=n_words)
    words.insert(rng.randrange(len(words) + 1), rare)
    lines, out = [], []
    for i, w in enumerate(words, 1):
        out.append(w)
        if i % 12 == 0:
            lines.append(" ".join(out))
            out = []
            if rng.random() < 0.15:
                lines.append("")
    if out:
        lines.append(" ".join(out))
    return "\r\n".join(lines)


def _wrap_b64(data):
    enc = base64.b64encode(data)
    return b"\r\n".join(enc[i:i + 76] for i in range(0, len(enc), 76))


def message(g, rcpt):
    """Message number g of the corpus, addressed to rcpt. Same g → same bytes."""
    rng = random.Random(g * 7919 + SEED)
    date = BASE_DATE - datetime.timedelta(seconds=rng.randrange(0, 2 * 365 * 86400))
    rare = f"zq{g % 1000:03d}x"  # about 1 in 1000 messages carries each rare term
    subject = " ".join(rng.choices(VOCAB, cum_weights=VOCAB_CUM, k=rng.randint(3, 8)))
    subject += f" project-{g % 100:02d}"
    sender = f"sender{rng.randrange(500)}@senders{rng.randrange(40)}.example.test"
    hdr = [
        f"From: {sender}",
        f"To: {rcpt}",
        f"Subject: {subject}",
        f"Date: {date.strftime('%a, %d %b %Y %H:%M:%S +0000')}",
        f"Message-ID: <{g}.{SEED}@loadtest.example.test>",
        "MIME-Version: 1.0",
    ]
    if g > 50 and rng.random() < 0.3:
        parent = g - rng.randrange(1, 50)
        hdr.append(f"In-Reply-To: <{parent}.{SEED}@loadtest.example.test>")
        hdr.append(f"References: <{parent}.{SEED}@loadtest.example.test>")
    kind = rng.random()
    boundary = f"=_lt{g}"
    if kind < 0.55:  # plain text, 1–8 KB
        hdr.append("Content-Type: text/plain; charset=utf-8")
        body = _text(rng, rng.randint(150, 1200), rare).encode()
    elif kind < 0.75:  # text + html alternative
        text = _text(rng, rng.randint(300, 2000), rare)
        html = "<html><body>" + "".join(f"<p>{p}</p>" for p in text.split("\r\n\r\n")) + "</body></html>"
        hdr.append(f'Content-Type: multipart/alternative; boundary="{boundary}"')
        body = (f"--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n"
                f"--{boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n"
                f"--{boundary}--\r\n").encode()
    elif kind < 0.95:  # text + one attachment (log-normal size, median 150 KB, max 8 MB)
        size = min(int(rng.lognormvariate(math.log(150_000), 1.0)), 8_000_000)
        text = _text(rng, rng.randint(100, 600), rare)
        hdr.append(f'Content-Type: multipart/mixed; boundary="{boundary}"')
        body = (f"--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n"
                f"--{boundary}\r\nContent-Type: application/pdf; name=\"doc{g}.pdf\"\r\n"
                f"Content-Disposition: attachment; filename=\"doc{g}.pdf\"\r\n"
                f"Content-Transfer-Encoding: base64\r\n\r\n").encode()
        body += _wrap_b64(rng.randbytes(size)) + f"\r\n--{boundary}--\r\n".encode()
    else:  # large html newsletter
        text = _text(rng, rng.randint(3000, 12000), rare)
        hdr.append("Content-Type: text/html; charset=utf-8")
        body = ("<html><body>" + "".join(f"<p>{p}</p>" for p in text.split("\r\n\r\n"))
                + "</body></html>").encode()
    seen = rng.random() < 0.7
    return ("\r\n".join(hdr) + "\r\n\r\n").encode() + body, date, seen


# ── measurement ────────────────────────────────────────────────────────────────────

class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.lat = {}
        self.err = {}
        self.bytes = 0

    def add(self, op, ms, nbytes=0):
        with self.lock:
            self.lat.setdefault(op, []).append(ms)
            self.bytes += nbytes

    def fail(self, op, exc):
        key = f"{op}: {type(exc).__name__}: {str(exc)[:120]}"
        with self.lock:
            self.err[key] = self.err.get(key, 0) + 1

    def count(self, op):
        with self.lock:
            return len(self.lat.get(op, []))

    def summary(self):
        out = {}
        with self.lock:
            for op, xs in sorted(self.lat.items()):
                s = sorted(xs)
                pick = lambda q: round(s[min(len(s) - 1, int(q * len(s)))], 2)
                out[op] = {"n": len(s), "p50": pick(0.5), "p95": pick(0.95), "p99": pick(0.99),
                           "max": round(s[-1], 2), "mean": round(sum(s) / len(s), 2)}
            return {"latency_ms": out, "errors": dict(self.err), "bytes": self.bytes}


def timed(stats, op, fn, nbytes=0):
    t = time.perf_counter()
    try:
        r = fn()
    except Exception as exc:  # noqa: BLE001 — every failure is counted, never fatal
        stats.fail(op, exc)
        return None
    stats.add(op, (time.perf_counter() - t) * 1000, nbytes)
    return r


def progress(stats, label, stop, every=30):
    def run():
        t0 = time.time()
        while not stop.wait(every):
            with stats.lock:
                n = sum(len(v) for v in stats.lat.values())
                e = sum(stats.err.values())
            log(f"{label}: {n} ops, {e} errors, {time.time() - t0:.0f}s")
    th = threading.Thread(target=run, daemon=True)
    th.start()
    return th


# ── protocol clients ───────────────────────────────────────────────────────────────

def imap_login(user, host=None):
    m = imaplib.IMAP4(host or HOST, 143, timeout=120)
    if "STARTTLS" in m.capabilities:
        m.starttls(ssl_context=TLS)
    m.login(address(user), user_password())
    return m


def imap_count(m, mailbox="INBOX"):
    typ, data = m.status(mailbox, "(MESSAGES)")
    return int(data[0].decode().split("MESSAGES")[1].strip(" )"))


class Jmap:
    """One HTTP connection, Basic auth. apiUrl from the session names the server's own
    hostname, which the test pod cannot resolve, so requests go to /jmap/ on HOST."""

    def __init__(self, user, password, host=None):
        self.host = host or HOST
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self.conn = None
        self.account_id = None

    def _req(self, method, path, body=None):
        for attempt in (1, 2):
            if self.conn is None:
                self.conn = http.client.HTTPConnection(self.host, JMAP_PORT, timeout=120)
            try:
                hdrs = {"Authorization": self.auth}
                if body is not None:
                    hdrs["Content-Type"] = "application/json"
                self.conn.request(method, path, body=body, headers=hdrs)
                r = self.conn.getresponse()
                data = r.read()
                if r.status >= 400:
                    raise RuntimeError(f"HTTP {r.status} {data[:200]!r}")
                return json.loads(data)
            except (http.client.HTTPException, ConnectionError, OSError):
                self.conn = None
                if attempt == 2:
                    raise

    def session(self, capability="urn:ietf:params:jmap:mail"):
        s = self._req("GET", "/jmap/session")
        self.account_id = s["primaryAccounts"].get(capability)
        return s

    def call(self, calls, using=("urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail")):
        r = self._req("POST", "/jmap/", json.dumps({"using": list(using), "methodCalls": calls}))
        for name, args, _ in r["methodResponses"]:
            if name == "error":
                raise RuntimeError(f"JMAP error {args}")
        return r["methodResponses"]


ADMIN_USING = ("urn:ietf:params:jmap:core", "urn:stalwart:jmap")


def admin():
    j = Jmap(os.environ.get("LT_ADMIN_USER", "admin"), os.environ["LT_ADMIN_PASSWORD"])
    j.session("urn:stalwart:jmap")
    j.account_id = j.account_id or "d333333"
    return j


def admin_call(j, method, args):
    args = {"accountId": j.account_id, **args}
    r = j._req("POST", "/jmap/", json.dumps({"using": list(ADMIN_USING),
                                               "methodCalls": [[method, args, "c0"]]}))
    name, res, _ = r["methodResponses"][0]
    if name == "error":
        raise RuntimeError(f"{method}: {res}")
    for key in ("notCreated", "notUpdated", "notDestroyed"):
        if res.get(key):
            raise RuntimeError(f"{method} {key}: {json.dumps(res[key])[:600]}")
    return res


# ── setup ──────────────────────────────────────────────────────────────────────────

def cmd_setup_bootstrap(a):
    j = admin()
    v1 = a.version == "1"
    single = {
        ("defaultHostname" if v1 else "serverHostname"): f"lt.{DOMAIN}",
        "defaultDomain": DOMAIN,
        "generateDkimKeys": False,
        "requestTlsCertificate": False,
    }
    single.update(json.loads(a.stores))
    res = admin_call(j, "x:Bootstrap/set", {"update": {"singleton": single}})
    return {"bootstrap": "ok", "response": res}


def cmd_setup_configure(a):
    j = admin()
    v1 = a.version == "1"
    out = {}
    doms = admin_call(j, "x:Domain/get", {"ids": None})["list"]
    dom = next((d for d in doms if d.get("name") == DOMAIN), None)
    if dom is None:
        create = {"name": DOMAIN}
        if v1:
            create["dkimManagement"] = {"@type": "Manual"}  # as the platform will (ADR-065)
        res = admin_call(j, "x:Domain/set", {"create": {"d": create}})
        dom_id = res["created"]["d"]["id"]
    else:
        dom_id = dom["id"]
    out["domainId"] = dom_id
    admin_call(j, "x:SystemSettings/set",
               {"update": {"singleton": {"defaultHostname": f"lt.{DOMAIN}", "defaultDomainId": dom_id}}})

    ips = {d.get("address") for d in admin_call(j, "x:AllowedIp/get", {"ids": None})["list"]}
    want = {"10.42.0.0/16": "pods", "10.43.0.0/16": "services"}
    create = {k: {"address": cidr, "reason": f"load test {k}"} for cidr, k in want.items() if cidr not in ips}
    if create:
        admin_call(j, "x:AllowedIp/set", {"create": create})

    listeners = admin_call(j, "x:NetworkListener/get", {"ids": None})["list"]
    out["listeners_before"] = [{"name": l.get("name"), "protocol": l.get("protocol"),
                                "bind": l.get("bind")} for l in listeners]
    bound = {int(b.rsplit(":", 1)[1]) for l in listeners for b in (l.get("bind") or {})}
    tls_key = "implicitTls" if v1 else "tlsImplicit"
    want_nl = {
        25: {"name": "lt-smtp", "bind": {"[::]:25": True}, "protocol": "smtp", tls_key: False},
        587: {"name": "lt-submission", "bind": {"[::]:587": True}, "protocol": "smtp", tls_key: False},
        143: {"name": "lt-imap", "bind": {"[::]:143": True}, "protocol": "imap", tls_key: False},
    }
    create = {v["name"]: v for port, v in want_nl.items() if port not in bound}
    if create:
        admin_call(j, "x:NetworkListener/set", {"create": create})
    out["listeners_created"] = sorted(create)

    # The default inbound throttles (5 messages/s per sender IP, 25/hour per sender domain and
    # recipient) would measure the throttle, not the store: one load generator is one IP and
    # one sender domain. Off for the test, recorded in the output.
    throttles = admin_call(j, "x:MtaInboundThrottle/get", {"ids": None})["list"]
    off = {t["id"]: {"enable": False} for t in throttles if t.get("enable")}
    if off:
        admin_call(j, "x:MtaInboundThrottle/set", {"update": off})
    out["throttles_disabled"] = [t.get("description") for t in throttles if t["id"] in off]

    # Per-account request rate limits (HTTP/JMAP and IMAP): the readers drive a few accounts
    # far harder than one user would, so the limits are lifted for the test. Their defaults
    # are recorded — they are what a real client meets.
    http = admin_call(j, "x:Http/get", {"ids": ["singleton"]})["list"][0]
    imap = admin_call(j, "x:Imap/get", {"ids": ["singleton"]})["list"][0]
    rate_key = "rateLimit" if v1 else "maxRequestRate"
    out["default_rate_limits"] = {"http_authenticated": http.get("rateLimitAuthenticated"),
                                  "http_anonymous": http.get("rateLimitAnonymous"),
                                  "imap": imap.get(rate_key)}
    admin_call(j, "x:Http/set", {"update": {"singleton": {"rateLimitAuthenticated": None,
                                                          "rateLimitAnonymous": None}}})
    imap_key = "maxConcurrentConnections" if v1 else "maxConcurrent"
    admin_call(j, "x:Imap/set", {"update": {"singleton": {"maxRequestSize": 104857600, imap_key: 64,
                                                          rate_key: None}}})
    admin_call(j, "x:Jmap/set", {"update": {"singleton": {
        "maxUploadSize": 104857600, "maxConcurrentUploads": 128, "maxConcurrentRequests": 128,
        "maxMethodCalls": 256}}})

    existing = {x.get("name") for x in admin_call(j, "x:Account/get",
                                                   {"ids": None, "properties": ["id", "name"]})["list"]}
    names = account_names(a.accounts) + [BIG_ACCOUNT]
    todo = [n for n in names if n not in existing]
    for i in range(0, len(todo), 50):
        batch = {n: {"@type": "User", "name": n, "domainId": dom_id,
                     "credentials": {"0": {"@type": "Password", "secret": user_password()}}}
                 for n in todo[i:i + 50]}
        admin_call(j, "x:Account/set", {"create": batch})
    out["accounts_created"] = len(todo)
    return out


def cmd_admin(a):
    j = admin()
    calls = json.load(sys.stdin)
    for c in calls:
        c[1] = {"accountId": j.account_id, **c[1]}
    r = j._req("POST", "/jmap/", json.dumps({"using": list(ADMIN_USING), "methodCalls": calls}))
    return r["methodResponses"]


# ── ingest ─────────────────────────────────────────────────────────────────────────

def corpus_plan(a):
    """[(account, mailbox, [g…])] — accounts u000… get per_account each, then the big one."""
    tasks = []
    for i, name in enumerate(account_names(a.accounts)):
        start = a.offset + i * a.per_account
        tasks.append((name, "INBOX", list(range(start, start + a.per_account))))
    start = a.offset + a.accounts * a.per_account
    big = list(range(start, start + a.big))
    for k in range(0, len(big), 500):  # several connections share the big mailbox
        chunk = big[k:k + 500]
        tasks.append((BIG_ACCOUNT, "Archive" if (k // 500) % 10 >= 7 else "INBOX", chunk))
    return tasks


def cmd_append(a):
    stats = Stats()
    tasks = corpus_plan(a)
    if a.big:
        m = imap_login(BIG_ACCOUNT)
        m.create("Archive")
        m.logout()

    def run(task):
        name, mbox, gs = task
        m = None
        for g in gs:
            msg, date, seen = message(g, address(name))
            for attempt in (1, 2, 3):
                try:
                    if m is None:
                        m = imap_login(name)
                    t = time.perf_counter()
                    typ, _ = m.append(mbox, "(\\Seen)" if seen else None,
                                      imaplib.Time2Internaldate(date.timestamp()), msg)
                    if typ != "OK":
                        raise RuntimeError(f"APPEND {typ}")
                    stats.add("append", (time.perf_counter() - t) * 1000, len(msg))
                    break
                except Exception as exc:  # noqa: BLE001
                    stats.fail("append", exc)
                    m = None
                    time.sleep(attempt)
        if m is not None:
            m.logout()

    stop = threading.Event()
    progress(stats, "append", stop)
    t0 = time.perf_counter()
    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(run, tasks))
    wall = time.perf_counter() - t0
    stop.set()
    s = stats.summary()
    n = s["latency_ms"].get("append", {}).get("n", 0)
    return {"cmd": "append", "workers": a.workers, "messages": n, "wall_s": round(wall, 1),
            "msg_per_s": round(n / wall, 2), "mb_per_s": round(s["bytes"] / wall / 1e6, 2), **s}


def mailbox_names(m):
    """Every selectable mailbox (the spam filter may have filed messages into Junk)."""
    typ, data = m.list()
    names = []
    for line in data or []:
        if not isinstance(line, bytes) or b"\\Noselect" in line:
            continue
        name = line.decode().rsplit(" ", 1)[1] if not line.endswith(b'"') else \
            '"' + line.decode().rsplit(' "', 1)[1]
        names.append(name)
    return names


def total_messages(names):
    def one(name):
        m = imap_login(name)
        try:
            return sum(imap_count(m, mbox) for mbox in mailbox_names(m))
        finally:
            m.logout()
    with ThreadPoolExecutor(8) as ex:
        return sum(ex.map(one, names))


def cmd_smtp(a):
    stats = Stats()
    names = account_names(a.accounts)
    before = total_messages(names)
    gs = list(range(a.offset, a.offset + a.count))
    chunks, i = [], 0
    rng = random.Random(SEED)
    while i < len(gs):
        k = rng.randint(1, 5)  # 1–5 messages per connection, like a sending MTA
        chunks.append(gs[i:i + k])
        i += k

    def run(chunk):
        s = None
        try:
            s = timed(stats, "connect", lambda: _smtp_connect())
            if s is None:
                return
            for g in chunk:
                rcpt = address(names[g % len(names)])
                msg, _, _ = message(g, rcpt)
                timed(stats, "deliver", lambda: s.sendmail(f"sender{g % 500}@senders.example.test",
                                                           [rcpt], msg), len(msg))
            s.quit()
        except Exception as exc:  # noqa: BLE001
            stats.fail("session", exc)

    stop = threading.Event()
    progress(stats, "smtp", stop)
    t0 = time.perf_counter()
    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(run, chunks))
    accept_wall = time.perf_counter() - t0
    delivered = stats.count("deliver")
    want = before + delivered
    now = before
    while time.perf_counter() - t0 < accept_wall + a.drain_timeout:
        now = total_messages(names)
        if now >= want:
            break
        time.sleep(5)
    drain_wall = time.perf_counter() - t0
    stop.set()
    s = stats.summary()
    return {"cmd": "smtp", "workers": a.workers, "accepted": delivered,
            "accept_wall_s": round(accept_wall, 1), "accept_msg_per_s": round(delivered / accept_wall, 2),
            "stored": now - before, "drain_wall_s": round(drain_wall, 1),
            "stored_msg_per_s": round((now - before) / drain_wall, 2), **s}


def _smtp_connect(host=None):
    s = smtplib.SMTP(host or HOST, 25, timeout=120, local_hostname="lt-loadgen.example.test")
    s.ehlo()
    if s.has_extn("starttls"):
        s.starttls(context=TLS)
        s.ehlo()
    return s


# ── reads ──────────────────────────────────────────────────────────────────────────

def imap_reader(stats, names, deadline, rng, prefix=""):
    while time.time() < deadline:
        name = BIG_ACCOUNT if rng.random() < 0.1 else rng.choice(names)
        m = timed(stats, prefix + "login", lambda: imap_login(name))
        if m is None:
            time.sleep(1)
            continue
        try:
            r = timed(stats, prefix + "select", lambda: m.select("INBOX"))
            if r is None:
                continue
            exists = int(r[1][0])
            if exists == 0:
                continue
            for _ in range(20):
                if time.time() >= deadline:
                    break
                n = rng.randint(1, exists)
                op = rng.random()
                if op < 0.30:
                    timed(stats, prefix + "fetch_body", lambda: m.fetch(str(n), "(BODY.PEEK[])"))
                elif op < 0.55:
                    lo = max(1, n - 49)
                    timed(stats, prefix + "fetch_headers",
                          lambda: m.fetch(f"{lo}:{n}", "(UID RFC822.SIZE FLAGS ENVELOPE INTERNALDATE)"))
                elif op < 0.65:
                    timed(stats, prefix + "search_subject",
                          lambda: m.search(None, "SUBJECT", f"project-{rng.randrange(100):02d}"))
                elif op < 0.75:
                    timed(stats, prefix + "search_body",
                          lambda: m.search(None, "BODY", f"zq{rng.randrange(1000):03d}x"))
                else:
                    flag = "+FLAGS" if rng.random() < 0.5 else "-FLAGS"
                    timed(stats, prefix + "store_flag", lambda: m.store(str(n), flag, "\\Flagged"))
        finally:
            try:
                m.logout()
            except Exception:  # noqa: BLE001
                pass


class JmapAccount:
    def __init__(self, name):
        self.j = Jmap(address(name), user_password())
        self.j.session()
        mb = self.j.call([["Mailbox/get", {"accountId": self.j.account_id,
                                           "properties": ["id", "role", "totalEmails"]}, "m"]])
        inbox = next(x for x in mb[0][1]["list"] if x.get("role") == "inbox")
        self.inbox, self.total = inbox["id"], inbox["totalEmails"]
        self.ids = []


def jmap_reader(stats, names, deadline, rng, prefix=""):
    cache = {}
    while time.time() < deadline:
        name = BIG_ACCOUNT if rng.random() < 0.1 else rng.choice(names)
        acc = cache.get(name)
        if acc is None:
            acc = timed(stats, prefix + "jmap_session", lambda: JmapAccount(name))
            if acc is None:
                time.sleep(1)
                continue
            cache[name] = acc
        aid, op = acc.j.account_id, rng.random()
        if op < 0.40 or not acc.ids:
            pos = rng.randint(0, max(0, min(acc.total, 500) - 50))
            r = timed(stats, prefix + "list_mailbox", lambda: acc.j.call([
                ["Email/query", {"accountId": aid, "filter": {"inMailbox": acc.inbox},
                                 "sort": [{"property": "receivedAt", "isAscending": False}],
                                 "position": pos, "limit": 50}, "q"],
                ["Email/get", {"accountId": aid, "#ids": {"resultOf": "q", "name": "Email/query",
                                                          "path": "/ids"},
                               "properties": ["id", "threadId", "subject", "from", "receivedAt",
                                              "preview", "size", "keywords", "hasAttachment"]}, "g"]]))
            if r:
                acc.ids = [e["id"] for e in r[1][1]["list"]]
                acc.threads = [e["threadId"] for e in r[1][1]["list"]]
        elif op < 0.65:
            eid = rng.choice(acc.ids)
            timed(stats, prefix + "open_email", lambda: acc.j.call([
                ["Email/get", {"accountId": aid, "ids": [eid], "fetchAllBodyValues": True,
                               "properties": ["id", "subject", "from", "to", "bodyValues", "textBody",
                                              "htmlBody", "attachments"]}, "g"]]))
        elif op < 0.80:
            timed(stats, prefix + "search_text", lambda: acc.j.call([
                ["Email/query", {"accountId": aid, "filter": {"text": f"zq{rng.randrange(1000):03d}x"},
                                 "limit": 50}, "q"]]))
        elif op < 0.90:
            tid = rng.choice(acc.threads)
            timed(stats, prefix + "thread", lambda: acc.j.call([
                ["Thread/get", {"accountId": aid, "ids": [tid]}, "t"]]))
        else:
            eid = rng.choice(acc.ids)
            val = True if rng.random() < 0.5 else None
            timed(stats, prefix + "set_keyword", lambda: acc.j.call([
                ["Email/set", {"accountId": aid, "update": {eid: {"keywords/$flagged": val}}}, "s"]]))


def _readers(a, kind):
    stats = Stats()
    names = account_names(a.accounts)
    deadline = time.time() + a.duration
    fn = imap_reader if kind == "imap" else jmap_reader
    stop = threading.Event()
    progress(stats, kind, stop)
    with ThreadPoolExecutor(a.workers) as ex:
        for w in range(a.workers):
            ex.submit(fn, stats, names, deadline, random.Random(SEED + w))
    stop.set()
    s = stats.summary()
    ops = sum(v["n"] for v in s["latency_ms"].values())
    return {"cmd": f"{kind}-read", "workers": a.workers, "duration_s": a.duration,
            "ops_per_s": round(ops / a.duration, 1), **s}


def cmd_imap_read(a):
    return _readers(a, "imap")


def cmd_jmap_read(a):
    return _readers(a, "jmap")


def cmd_big(a):
    stats = Stats()
    m = imap_login(BIG_ACCOUNT)
    r = timed(stats, "select_cold", lambda: m.select("INBOX"))
    exists = int(r[1][0]) if r else 0
    timed(stats, "fetch_all_flags", lambda: m.uid("FETCH", "1:*", "(FLAGS)"))
    timed(stats, "fetch_last_50_envelopes",
          lambda: m.fetch(f"{max(1, exists - 49)}:{exists}", "(UID RFC822.SIZE FLAGS ENVELOPE)"))
    for k in range(5):
        timed(stats, "search_body_rare", lambda: m.search(None, "BODY", f"zq{(k * 197) % 1000:03d}x"))
        timed(stats, "search_subject", lambda: m.search(None, "SUBJECT", f"project-{k * 13:02d}"))
        timed(stats, "search_since", lambda: m.search(None, "SINCE", "01-Jan-2026"))
    m.close()
    timed(stats, "select_warm", lambda: m.select("INBOX"))
    m.logout()
    acc = JmapAccount(BIG_ACCOUNT)
    aid = acc.j.account_id
    timed(stats, "jmap_query_total", lambda: acc.j.call([
        ["Email/query", {"accountId": aid, "filter": {"inMailbox": acc.inbox},
                         "calculateTotal": True, "limit": 1}, "q"]]))
    timed(stats, "jmap_query_deep", lambda: acc.j.call([
        ["Email/query", {"accountId": aid, "filter": {"inMailbox": acc.inbox},
                         "sort": [{"property": "receivedAt", "isAscending": False}],
                         "position": max(0, exists - 100), "limit": 50}, "q"]]))
    for k in range(5):
        timed(stats, "jmap_search_text", lambda: acc.j.call([
            ["Email/query", {"accountId": aid, "filter": {"text": f"zq{(k * 389) % 1000:03d}x"},
                             "limit": 50}, "q"]]))
    return {"cmd": "big", "messages_inbox": exists, **stats.summary()}


def cmd_mixed(a):
    stats = Stats()
    names = account_names(a.accounts)
    deadline = time.time() + a.duration
    interval = 1.0 / a.smtp_rate
    counter = {"g": a.offset}
    lock = threading.Lock()

    def sender(rng):
        nxt = time.time()
        s = None
        while time.time() < deadline:
            now = time.time()
            if now < nxt:
                time.sleep(nxt - now)
            nxt += interval * a.smtp_workers
            with lock:
                g = counter["g"]
                counter["g"] += 1
            rcpt = address(names[g % len(names)])
            msg, _, _ = message(g, rcpt)
            try:
                if s is None:
                    s = _smtp_connect()
                t = time.perf_counter()
                s.sendmail(f"sender{g % 500}@senders.example.test", [rcpt], msg)
                stats.add("smtp_deliver", (time.perf_counter() - t) * 1000, len(msg))
                if rng.random() < 0.3:
                    s.quit()
                    s = None
            except Exception as exc:  # noqa: BLE001
                stats.fail("smtp_deliver", exc)
                s = None

    stop = threading.Event()
    progress(stats, "mixed", stop)
    with ThreadPoolExecutor(a.smtp_workers + a.imap_workers + a.jmap_workers) as ex:
        for w in range(a.smtp_workers):
            ex.submit(sender, random.Random(SEED * 3 + w))
        for w in range(a.imap_workers):
            ex.submit(imap_reader, stats, names, deadline, random.Random(SEED + w), "imap_")
        for w in range(a.jmap_workers):
            ex.submit(jmap_reader, stats, names, deadline, random.Random(SEED * 7 + w), "jmap_")
    stop.set()
    return {"cmd": "mixed", "duration_s": a.duration, "smtp_rate": a.smtp_rate,
            "smtp_sent": stats.count("smtp_deliver"), "next_offset": counter["g"], **stats.summary()}


# ── delete, sample, compare ────────────────────────────────────────────────────────

def cmd_delete(a):
    stats = Stats()
    names = account_names(a.accounts) + [BIG_ACCOUNT]
    totals = {"messages": 0, "bytes": 0}
    lock = threading.Lock()
    step = round(1 / a.fraction)

    def run(name):
        m = imap_login(name)
        try:
            exists = int(m.select("INBOX")[1][0])
            seqs = [n for n in range(1, exists + 1) if n % step == 0]
            nbytes = 0
            for i in range(0, len(seqs), 500):
                part = ",".join(map(str, seqs[i:i + 500]))
                typ, data = m.fetch(part, "(RFC822.SIZE)")
                for d in data:
                    if isinstance(d, bytes) and b"RFC822.SIZE" in d:
                        nbytes += int(d.split(b"RFC822.SIZE")[1].strip(b" )"))
                timed(stats, "store_deleted", lambda: m.store(part, "+FLAGS", "\\Deleted"))
            timed(stats, "expunge", lambda: m.expunge())
            with lock:
                totals["messages"] += len(seqs)
                totals["bytes"] += nbytes
        finally:
            m.logout()

    t0 = time.perf_counter()
    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(run, names))
    return {"cmd": "delete", "fraction": a.fraction, "deleted": totals,
            "wall_s": round(time.perf_counter() - t0, 1), **stats.summary()}


def cmd_sample(a):
    names = account_names(a.accounts) + [BIG_ACCOUNT]

    def one(name):
        m = imap_login(name)
        try:
            out = {}
            for mbox in ("INBOX", "Archive") if name == BIG_ACCOUNT else ("INBOX",):
                typ, data = m.status(mbox, "(MESSAGES UIDVALIDITY UIDNEXT)")
                if typ != "OK":
                    continue
                st = data[0].decode()
                exists = int(m.select(mbox, readonly=True)[1][0])
                rng = random.Random(f"{name}/{mbox}")
                picks = sorted(rng.sample(range(1, exists + 1), min(a.per_account, exists)))
                msgs = {}
                for n in picks:
                    typ, d = m.fetch(str(n), "(UID FLAGS BODY.PEEK[])")
                    head, body = d[0]
                    uid = head.decode().split("UID ")[1].split(" ")[0]
                    msgs[uid] = hashlib.sha256(body).hexdigest()
                out[mbox] = {"status": st.split("(", 1)[1].rstrip(")"), "messages": exists,
                             "sample": msgs}
            return name, out
        finally:
            m.logout()

    with ThreadPoolExecutor(8) as ex:
        return dict(ex.map(one, names))


def cmd_compare(a):
    src, dst = json.load(open(a.source)), json.load(open(a.target))
    diffs = []
    src = {k: v for k, v in src.items() if isinstance(v, dict)}  # drop "started"
    for name, boxes in src.items():
        for mbox, s in boxes.items():
            d = dst.get(name, {}).get(mbox)
            if d is None:
                diffs.append(f"{name}/{mbox}: missing")
                continue
            if s["status"] != d["status"] or s["messages"] != d["messages"]:
                diffs.append(f"{name}/{mbox}: status {s['status']} → {d['status']}")
            for uid, h in s["sample"].items():
                if d["sample"].get(uid) != h:
                    diffs.append(f"{name}/{mbox}: uid {uid} body differs")
    checked = sum(len(b["sample"]) for boxes in src.values() for b in boxes.values())
    return {"cmd": "compare", "checked_messages": checked, "differences": diffs[:50],
            "ok": not diffs}


def cmd_counts(a):
    names = account_names(a.accounts) + [BIG_ACCOUNT]
    m = imap_login(names[0])
    per_mailbox = {mbox: imap_count(m, mbox) for mbox in mailbox_names(m)}
    m.logout()
    return {"cmd": "counts", "total": total_messages(names), f"{names[0]}_mailboxes": per_mailbox}


def cmd_idle_probe(a):
    """APPEND on --via, time the EXISTS on an IDLE connection to --watch (another node).
    APPEND, not SMTP: the spam filter may file an SMTP message into Junk, which an INBOX
    IDLE never sees. --via == --watch is the same-node control."""
    stats = Stats()
    name = account_names(1)[0]
    writer = imap_login(name, a.via)
    for k in range(a.count):
        m = imap_login(name, a.watch)
        exists = int(m.select("INBOX")[1][0])
        tag = m._new_tag().decode()
        m.send(f"{tag} IDLE\r\n".encode())
        m.readline()  # "+ idling"
        msg, date, _ = message(a.offset + k, address(name))
        t = time.perf_counter()
        writer.append("INBOX", None, imaplib.Time2Internaldate(date.timestamp()), msg)
        m.sock.settimeout(a.timeout)
        try:
            while True:
                line = m.readline()
                if b"EXISTS" in line and int(line.split()[1]) > exists:
                    stats.add("idle_notice", (time.perf_counter() - t) * 1000)
                    break
        except Exception as exc:  # noqa: BLE001
            stats.fail("idle_notice", exc)
        m.send(b"DONE\r\n")
        m.logout()
    writer.logout()
    return {"cmd": "idle-probe", "via": a.via, "watch": a.watch, **stats.summary()}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--accounts", type=int, default=50)
    for name, extra in [
        ("setup-bootstrap", [("--version", str, "1"), ("--stores", str, "{}")]),
        ("setup-configure", [("--version", str, "1")]),
        ("admin", []),
        ("append", [("--per-account", int, 600), ("--big", int, 25000), ("--offset", int, 0),
                    ("--workers", int, 8)]),
        ("smtp", [("--count", int, 5000), ("--offset", int, 1_000_000), ("--workers", int, 10),
                  ("--drain-timeout", int, 1800)]),
        ("imap-read", [("--duration", int, 180), ("--workers", int, 16)]),
        ("jmap-read", [("--duration", int, 180), ("--workers", int, 16)]),
        ("big", []),
        ("mixed", [("--duration", int, 300), ("--smtp-rate", float, 5.0), ("--smtp-workers", int, 4),
                   ("--imap-workers", int, 8), ("--jmap-workers", int, 8), ("--offset", int, 2_000_000)]),
        ("delete", [("--fraction", float, 0.5), ("--workers", int, 8)]),
        ("sample", [("--per-account", int, 20)]),
        ("compare", [("--source", str, ""), ("--target", str, "")]),
        ("counts", []),
        ("idle-probe", [("--via", str, ""), ("--watch", str, ""), ("--count", int, 20),
                        ("--offset", int, 3_000_000), ("--timeout", int, 30)]),
    ]:
        sp = sub.add_parser(name, parents=[common])
        for flag, typ, default in extra:
            sp.add_argument(flag, type=typ, default=default)
    a = p.parse_args()
    fn = globals()["cmd_" + a.cmd.replace("-", "_")]
    t0 = time.time()
    out = fn(a)
    if isinstance(out, dict):
        out.setdefault("started", datetime.datetime.fromtimestamp(t0, datetime.timezone.utc).isoformat())
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
