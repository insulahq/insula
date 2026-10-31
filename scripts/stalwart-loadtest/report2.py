#!/usr/bin/env python3
"""report2.py <results-dir> [production-store-bytes] — markdown tables for r2.sh (ADR-065, round 2).

Memory per component (cgroup split from sampler.py: need = anon + shmem + kernel, cache = page
cache), total storage per shape after the store settled, the platform's mailbox backup and restore
(IMAP and JMAP engines), store-level backup and restore, and what deleting an account or mail frees.
"""
import json
import os
import sys
from collections import defaultdict

from report import GIB, Run, fmt, gib, jsonl, samples, table

# container → component; PostgreSQL's barman sidecar and Valkey's sentinel count apart
COMPONENT = {"stalwart": "stalwart", "postgres": "postgres", "plugin-barman-cloud": "barman sidecar",
             "valkey": "valkey", "sentinel": "sentinel", "garage": "garage", "tools": "backup tools",
             "loadgen": "load generator"}


def mem_peaks(run, v, phases):
    """{(component, pod): {need, cache, rss, ws}} — peaks over the phases' windows."""
    out = defaultdict(lambda: {"need": 0, "cache": 0, "rss": 0, "ws": 0})
    wins = [run.windows[(v, p)] for p in phases if (v, p) in run.windows and None not in run.windows[(v, p)]]
    if not wins:
        return {}
    for s in samples(run.d):
        comp = COMPONENT.get(s.get("container"))
        if comp is None or not any(w[0] - 5 <= s["t"] <= w[1] + 5 for w in wins):
            continue
        m, key = s.get("mem") or {}, (comp, s["pod"])
        o = out[key]
        o["need"] = max(o["need"], m.get("need", 0))
        o["cache"] = max(o["cache"], m.get("cache", 0))
        o["rss"] = max(o["rss"], s.get("rss") or 0)
        o["ws"] = max(o["ws"], s.get("ws") or 0)
    return out


def variants(d):
    return sorted(x for x in os.listdir(d) if os.path.isdir(f"{d}/{x}") and x.startswith("v"))


def memory_section(run, vs):
    rows = []
    for v in vs:
        peaks = mem_peaks(run, v, ["append", "smtp", "mixed", "imap-read", "jmap-read"])
        by = defaultdict(list)
        for (comp, pod), m in peaks.items():
            by[comp].append(m)
        for comp in ("stalwart", "postgres", "barman sidecar", "valkey", "sentinel", "garage"):
            ms = by.get(comp)
            if not ms:
                continue
            need = sorted(m["need"] for m in ms)
            rows.append([v, comp, len(ms), " / ".join(gib(x) for x in need), gib(sum(need)),
                         gib(max(m["cache"] for m in ms)), gib(max(m["ws"] for m in ms))])
    return ["## Memory per component (GiB, peak over ingest, mixed load and reads)", "",
            table(["shape", "component", "pods", "need per pod (anon+shmem+kernel)", "need total",
                   "page cache, largest pod", "working set, largest pod"], rows), "",
            "*need* is what the component holds and cannot give back: process memory plus "
            "PostgreSQL's shared buffers (shmem) plus kernel memory. Page cache comes on top up to the "
            "limit and is reclaimed under pressure.", ""]


def storage_section(run, vs, prod_bytes):
    rows = []
    for v in vs:
        s = run.size(v, "settled")
        if not s:
            continue
        a, sm = run.phase(v, "append"), run.phase(v, "smtp")
        raw = ((a or {}).get("bytes") or 0) + ((sm or {}).get("bytes") or 0)
        pg = s.get("pg") or {}
        inst = pg.get("instances") or []
        pg_alloc = sum(i.get("alloc", 0) for i in inst)
        pg_wal = sum(i.get("wal_alloc", 0) for i in inst)
        garage = sum(n.get("alloc", 0) for n in ((s.get("s3") or {}).get("nodes") or []))
        total = (s.get("data_alloc") or 0) + (s.get("blob_alloc") or 0) + pg_alloc + garage
        rows.append([v, gib(raw), gib(s.get("data_alloc")), gib(s.get("blob_alloc")), s.get("blob_files"),
                     f"{len(inst)} × {gib(pg_alloc / len(inst))}" if inst else "–",
                     gib(pg_wal) if inst else "–", gib(garage) if garage else "–", gib(total),
                     round(total / raw, 2) if raw else None,
                     f"{total / raw * prod_bytes / 1e9:.0f}" if raw and prod_bytes else "–"])
    return ["## Total storage, store at rest (GiB allocated on disk)", "",
            table(["shape", "raw mail", "data dir", "blob dir", "blob files", "PostgreSQL volumes",
                   "of which pg_wal", "Garage volumes", "total", "total / raw",
                   "at production's size (GB)"], rows), "",
            "Allocated blocks (`du -B1`), so a 2 KB blob file counts as 4 KiB. *At production's size* scales "
            "the ratio to production's 0.16 store as measured on disk (RocksDB, 0.16's own ratio 1.0 = "
            f"{prod_bytes / 1e9:.1f} GB)." if prod_bytes else "", ""]


def backup_section(run, vs):
    rows, rest = [], []
    checks = jsonl(f"{run.d}/restore-check.jsonl")
    for v in vs:
        bk = [b for b in jsonl(f"{run.d}/backup.jsonl") if b.get("variant") == v]
        if not bk:
            continue
        msgs = {(c["mailbox"]): c["source_messages"] for c in checks if c["variant"] == v and c["engine"] == "imap"}
        repo = next((b for b in bk if b.get("step") == "restic-repo"), {})
        for step in ("capture", "restore"):
            for engine in ("imap", "jmap"):
                xs = [b for b in bk if b.get("step") == step and b.get("engine") == engine]
                if not xs:
                    continue
                big = next((b for b in xs if b["mailbox"] == "big"), None)
                small = [b for b in xs if b["mailbox"] != "big"]
                n_big, n_small = msgs.get("big"), sum(msgs.get(b["mailbox"], 0) for b in small)
                t_small = sum(float(b["seconds"]) for b in small)
                ok = [c for c in checks if c["variant"] == v and c["engine"] == engine]
                rows.append([v, step, engine,
                             f"{n_big / float(big['seconds']):.0f}" if big and n_big else "–",
                             f"{n_small / t_small:.0f}" if small and n_small and t_small else "–",
                             sum(1 for b in xs if b.get("rc") != 0),
                             f"{sum(c['identical'] for c in ok)}/{len(ok)}" if step == "restore" else "–"])
        rb = [b for b in bk if b.get("step") == "restic-backup"]
        rr = next((b for b in bk if b.get("step") == "restic-restore"), None)
        if rb:
            rest.append([v, round(sum(float(b["seconds"]) for b in rb), 1), gib(repo.get("capture_bytes")),
                         gib(repo.get("bytes")), rr and rr["seconds"]])
    return ["## Mailbox backup and restore — the platform's tools (msg/s)", "",
            table(["shape", "step", "engine", "large mailbox", "five small, one after another",
                   "failed runs", "restored identical"], rows), "",
            "IMAP engine = production (imap-sync.py one connection; imap-restore.py MULTIAPPEND, 4 "
            "connections). JMAP engine = the legacy scripts the image still carries (jmap-sync.py 8 "
            "download workers; jmap-restore.py 16 workers). *Identical*: every folder's messages, flags, "
            "keywords, INTERNALDATE and sizes match the source (UIDs aside).", "",
            table(["shape", "restic backup s (6 mailboxes)", "Maildir GiB", "repo GiB", "restic restore of the large one s"],
                  rest), ""]


def store_backup_section(run):
    rows = []
    for b in jsonl(f"{run.d}/store-backup.jsonl"):
        if b["kind"].startswith("restic"):
            rows.append([b["variant"], b["kind"], b.get("files"), gib(b.get("bytes")), gib(b.get("repo_bytes")),
                         b.get("first_s"), b.get("incremental_s"), b.get("restore_s")])
        else:
            rows.append([b["variant"], b["kind"] + (f" ({b.get('phase')})" if b.get("phase") else ""), "–",
                         gib(int(b["db_bytes"])) if str(b.get("db_bytes") or "").isdigit() else "–", "–",
                         b.get("seconds") if b["kind"] == "cnpg-backup" else "–", "–",
                         b.get("seconds") if b["kind"] == "cnpg-recovery" else "–"])
    return ["## Store-level backup and restore", "",
            table(["shape", "copy", "files", "GiB", "repo GiB", "first s", "after +500 mails s", "restore s"], rows),
            "", "restic over the store directory (today's stalwart-snapshot reads RocksDB the same way), and for "
                "PostgreSQL a CNPG base backup to the lab S3 through the barman-cloud plugin and a new cluster "
                "recovered from it.", ""]


def retention_section(run, vs):
    rows = []
    for r in jsonl(f"{run.d}/retention.jsonl"):
        v = r["variant"]
        before, after = run.size(v, "before-account-delete"), run.size(v, "after-account-delete")
        rel = run.size(v, "after-account-samples-released")

        def tot(s):
            if not s:
                return None
            pg = (s.get("pg") or {}).get("db_bytes") or 0
            return (s.get("data_bytes") or 0) + (s.get("blob_bytes") or 0) + pg
        b, a, x = tot(before), tot(after), tot(rel)
        rows.append([v, r["account"], gib(b), gib(a), gib(x), r.get("samples_left"), r.get("seconds")])
    return ["## Deleting a whole account (store total, GiB)", "",
            table(["shape", "account", "before", "after delete + blob purge", "after its training samples are released",
                   "training samples left behind", "seconds"], rows), ""]


def main():
    d = sys.argv[1]
    prod = int(sys.argv[2]) if len(sys.argv) > 2 else 51_505_609_616  # production 0.16 store, 2026-10-31
    run = Run(d)
    vs = variants(d)
    out = [f"# Stalwart store evaluation, round 2 — run {os.path.basename(d.rstrip('/'))}", ""]
    out += memory_section(run, vs)
    out += storage_section(run, vs, prod)
    out += backup_section(run, vs)
    out += store_backup_section(run)
    out += retention_section(run, vs)
    print("\n".join(out))


if __name__ == "__main__":
    main()
