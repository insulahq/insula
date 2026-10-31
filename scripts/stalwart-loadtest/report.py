#!/usr/bin/env python3
"""report.py <results-dir> — markdown tables from one lt.sh run (ADR-065 evaluation).

Reads <variant>/<phase>.json (load generator), phases.jsonl (phase windows), samples.jsonl
(kubelet CPU/memory every 5 s), sizes.jsonl, backups.jsonl, restarts.jsonl, migrations.jsonl.
CPU per phase = the sum of positive deltas of each container's cumulative CPU inside the
phase window (a restarted container's counter starts again at zero).
"""
import json
import os
import sys
from collections import defaultdict

GROUPS = {"stalwart": "stalwart", "postgres": "postgres", "rclone": "s3", "valkey": "valkey",
          "migrate": "migrate", "loadgen": "loadgen"}
VARIANTS = ["v016-rocks", "v1-rocks", "v1-pg", "v1-pg-fs", "v1-pg-s3", "v1-pg-s3remote",
            "v1-pg-cluster"]
GIB = 2 ** 30


def jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path):
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


class Run:
    def __init__(self, d):
        self.d = d
        self.windows = {}
        for e in jsonl(f"{d}/phases.jsonl"):
            key = (e["variant"], e["phase"])
            w = self.windows.setdefault(key, [None, None])
            w[0 if e["event"] == "start" else 1] = e["t"]
        self.samples = defaultdict(list)  # (pod, container) → [(t, cpu_ns, ws)]
        for s in jsonl(f"{d}/samples.jsonl"):
            if "pod" in s and s.get("cpu_ns") is not None:
                self.samples[(s["pod"], s["container"])].append((s["t"], s["cpu_ns"], s.get("ws") or 0))
        self.sizes = jsonl(f"{d}/sizes.jsonl")

    def phase(self, v, p):
        f = f"{self.d}/{v}/{p}.json"
        if not os.path.exists(f):
            return None
        try:
            return json.load(open(f))
        except ValueError:
            return None

    def usage(self, v, p):
        """{group: (cpu_seconds, peak_working_set_bytes)} inside the phase window."""
        w = self.windows.get((v, p))
        if not w or None in w:
            return {}
        out = defaultdict(lambda: [0.0, 0])
        for (pod, c), xs in self.samples.items():
            g = GROUPS.get(c)
            if g is None:
                continue
            prev = None
            for t, cpu, ws in xs:
                if t < w[0] - 5 or t > w[1] + 5:
                    prev = (t, cpu) if t < w[0] else prev
                    continue
                if prev is not None and cpu >= prev[1]:
                    out[g][0] += (cpu - prev[1]) / 1e9
                out[g][1] = max(out[g][1], ws)
                prev = (t, cpu)
        return {g: (round(c, 1), m) for g, (c, m) in out.items()}

    def size(self, v, label):
        for s in reversed(self.sizes):
            if s["variant"] == v and s["label"] == label:
                return s
        return None


def lat(d, op, q="p95"):
    try:
        return d["latency_ms"][op][q]
    except (KeyError, TypeError):
        return None


def fmt(x, nd=1):
    if x is None:
        return "–"
    if isinstance(x, float):
        return f"{x:.{nd}f}"
    return str(x)


def gib(b):
    return "–" if b is None else f"{b / GIB:.2f}"


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(fmt(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def store_bytes(s):
    """Everything the variant keeps on disk: data dir, blob dir, PostgreSQL volume, S3."""
    if not s:
        return None
    total = (s.get("data_bytes") or 0) + (s.get("blob_bytes") or 0)
    if s.get("pg"):
        total += s["pg"].get("pvc_bytes") or s["pg"].get("db_bytes") or 0
    if s.get("s3"):
        total += s["s3"].get("bytes") or 0
    return total


def main():
    r = Run(sys.argv[1])
    vs = [v for v in VARIANTS if os.path.isdir(f"{r.d}/{v}")]
    out = [f"# Stalwart store evaluation — run {os.path.basename(r.d.rstrip('/'))}", ""]
    env = f"{r.d}/environment.txt"
    if os.path.exists(env):
        out += ["```", open(env).read().strip(), "```", ""]

    rows = []
    for v in vs:
        a, s = r.phase(v, "append"), r.phase(v, "smtp")
        ua = r.usage(v, "append")
        cpu = sum(c for g, (c, _) in ua.items() if g in ("stalwart", "postgres", "s3", "valkey"))
        n = (a or {}).get("messages") or 0
        rows.append([v, (a or {}).get("msg_per_s"), (a or {}).get("mb_per_s"), lat(a, "append", "p50"),
                     lat(a, "append"), round(cpu / n * 1000, 1) if n else None,
                     (s or {}).get("accept_msg_per_s"), (s or {}).get("stored_msg_per_s"),
                     lat(s, "deliver", "p50"), lat(s, "deliver"),
                     gib(ua.get("stalwart", (0, None))[1]), gib(ua.get("postgres", (0, None))[1])])
    out += ["## Ingest", "", table(["variant", "APPEND msg/s", "MB/s", "p50 ms", "p95 ms",
                                    "CPU-s / 1k msgs", "SMTP accepted msg/s", "stored msg/s",
                                    "deliver p50 ms", "p95 ms", "Stalwart peak GiB", "PG peak GiB"], rows), ""]

    for kind, ops in (("imap", ["select", "fetch_headers", "fetch_body", "search_subject", "search_body",
                                "store_flag", "login"]),
                      ("jmap", ["list_mailbox", "open_email", "search_text", "thread", "set_keyword"])):
        rows = []
        for v in vs:
            d = r.phase(v, f"{kind}-read")
            if not d:
                continue
            errs = sum(d.get("errors", {}).values())
            rows.append([v, d.get("ops_per_s")] + [f"{fmt(lat(d, o, 'p50'), 2)} / {fmt(lat(d, o), 2)}" for o in ops]
                        + [errs])
        out += [f"## {kind.upper()} reads (ms, p50 / p95)", "",
                table(["variant", "ops/s"] + ops + ["errors"], rows), ""]

    ops = ["select_cold", "fetch_all_flags", "search_body_rare", "search_subject", "jmap_query_total",
           "jmap_query_deep", "jmap_search_text"]
    rows = []
    for v in vs:
        for p in ("big", "big-cold"):
            d = r.phase(v, p)
            if d:
                h = d.get("hits") or {}
                hits = "/".join("–" if not h.get(o) else str(min(h[o])) for o in ("search_body_rare",
                                                                                   "jmap_search_text"))
                rows.append([f"{v} ({'after restart' if p == 'big-cold' else 'warm'})",
                             d.get("messages_inbox")] + [lat(d, o, "max") for o in ops] + [hits])
    out += ["## Large mailbox (ms, worst of the samples)", "",
            table(["variant", "messages"] + ops + ["fewest rare-term hits IMAP/JMAP"], rows), ""]

    rows = []
    for v in vs:
        d = r.phase(v, "mixed")
        if d:
            rows.append([v, d.get("smtp_sent"), lat(d, "smtp_deliver"), lat(d, "imap_fetch_body"),
                         lat(d, "imap_search_body"), lat(d, "jmap_list_mailbox"), lat(d, "jmap_search_text"),
                         sum(d.get("errors", {}).values())])
    out += ["## Mixed load (p95 ms; SMTP 5 msg/s + 8 IMAP + 8 JMAP clients)", "",
            table(["variant", "SMTP sent", "SMTP deliver", "IMAP fetch body", "IMAP search body",
                   "JMAP list", "JMAP search", "errors"], rows), ""]

    rows = []
    for v in vs:
        s = r.size(v, "after-smtp")
        a, sm = r.phase(v, "append"), r.phase(v, "smtp")
        raw = ((a or {}).get("bytes") or 0) + ((sm or {}).get("bytes") or 0)
        if not s or not raw:
            continue
        pg = s.get("pg") or {}
        total = store_bytes(s)
        e = r.size(v, "empty") or {}
        wal = (pg.get("wal_bytes") or 0) - ((e.get("pg") or {}).get("wal_bytes") or 0)
        rows.append([v, gib(raw), gib(s.get("data_bytes")), gib(s.get("blob_bytes")), s.get("blob_files"),
                     gib(pg.get("db_bytes")), gib(wal) if pg else "–", gib((s.get("s3") or {}).get("bytes")),
                     gib(total), round(total / raw, 2)])
    out += ["## Storage after ingest (GiB)", "",
            table(["variant", "raw mail", "data dir", "blob dir", "blob files", "PG database",
                   "WAL written", "S3", "total on disk", "disk / raw"], rows), ""]

    labels = ["before-delete", "after-delete", "after-purge", "after-purge-10min", "after-vacuum",
              "after-reappend", "after-vacuum-full"]
    rows = []
    for v in vs:
        d = r.phase(v, "delete")
        row = [v, gib(((d or {}).get("deleted") or {}).get("bytes"))]
        row += [gib(store_bytes(r.size(v, lab))) for lab in labels]
        rows.append(row)
    out += ["## Deleting half of every mailbox (total on disk, GiB)", "",
            table(["variant", "raw deleted"] + labels, rows), ""]

    rows = []
    restarts = {x["variant"]: x["restart_seconds"] for x in jsonl(f"{r.d}/restarts.jsonl")}
    for b in jsonl(f"{r.d}/backups.jsonl"):
        rows.append([b["variant"], b["kind"], gib(b["bytes"]), b["seconds"],
                     round(b["bytes"] / max(float(b["seconds"]), 0.1) / 1e6, 1), restarts.get(b["variant"])])
    out += ["## Full copy of the store, restart", "",
            table(["variant", "copy", "GiB", "seconds", "MB/s", "restart to ready s"], rows), ""]

    mig = jsonl(f"{r.d}/migrations.jsonl")
    if mig:
        rows = [[m.get("variant"), m.get("step") or ", ".join(k for k in m if k != "variant"),
                 m.get("seconds", m.get("window_seconds", m.get("index_rebuild_seconds"))), m.get("rc", "")]
                for m in mig]
        out += ["## Migration", "", table(["migration", "step", "seconds", "rc"], rows), ""]
        for mv in ("mig-rocks", "mig-pg"):
            c = r.phase(mv, "compare")
            if c:
                out.append(f"- {mv}: sample compare {c.get('checked_messages')} messages, ok={c.get('ok')}, "
                           f"differences={c.get('differences')}")
            d = r.phase(mv, "mixed-during-copy")
            base = r.phase("v016-rocks", "mixed")
            if d and base:
                out.append(f"- {mv}: p95 during the live copy vs. without — SMTP "
                           f"{lat(d, 'smtp_deliver')} / {lat(base, 'smtp_deliver')} ms, IMAP fetch "
                           f"{lat(d, 'imap_fetch_body')} / {lat(base, 'imap_fetch_body')} ms, JMAP list "
                           f"{lat(d, 'jmap_list_mailbox')} / {lat(base, 'jmap_list_mailbox')} ms")
            u = r.usage(mv, "run-1-live")
            if u:
                out.append(f"- {mv}: live copy used migrate {u.get('migrate', ('–',))[0]} CPU-s, peak "
                           f"{gib(u.get('migrate', (0, None))[1])} GiB")
        out.append("")

    v = "v1-pg-cluster"
    if os.path.isdir(f"{r.d}/{v}"):
        rows = []
        for p in ("idle-a-to-a", "idle-a-to-b", "idle-b-to-a"):
            d = r.phase(v, p)
            if d:
                rows.append([p, lat(d, "idle_notice", "p50"), lat(d, "idle_notice"),
                             (d.get("latency_ms", {}).get("idle_notice") or {}).get("n"),
                             sum(d.get("errors", {}).values())])
        f = r.phase(v, "smtp-failover") or {}
        out += ["## Two-node cluster", "", table(["IDLE probe", "p50 ms", "p95 ms", "notices", "missed"], rows),
                "", f"- SMTP with one pod deleted after 60 s: accepted {f.get('accepted')}, stored "
                    f"{f.get('stored')}, session errors {sum(f.get('errors', {}).values()) if f else '–'}", ""]
    print("\n".join(out))


if __name__ == "__main__":
    main()
