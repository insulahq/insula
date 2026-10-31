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
    """{component: {"pods": [peak need per pod], "need": peak of the summed need of the pods running at
    the same moment, "cache"/"ws": largest pod}} over the phases' windows. Pods replaced by a restart
    are not added to each other: the sum is taken per sampling instant."""
    wins = [run.windows[(v, p)] for p in phases if (v, p) in run.windows and None not in run.windows[(v, p)]]
    if not wins:
        return {}
    per_pod = defaultdict(lambda: defaultdict(lambda: {"need": 0, "cache": 0, "ws": 0}))
    at = defaultdict(lambda: defaultdict(int))  # component → rounded t → summed need
    for s in samples(run.d):
        comp = COMPONENT.get(s.get("container"))
        if comp is None or not any(w[0] - 5 <= s["t"] <= w[1] + 5 for w in wins):
            continue
        m = s.get("mem") or {}
        need = m.get("need", 0)
        o = per_pod[comp][s["pod"]]
        o["need"] = max(o["need"], need)
        o["cache"] = max(o["cache"], m.get("cache", 0))
        o["ws"] = max(o["ws"], s.get("ws") or 0)
        at[comp][round(s["t"] / 5)] += need
    out = {}
    for comp, pods in per_pod.items():
        live = [x for x in pods.values() if x["need"] > 0]
        out[comp] = {"pods": sorted((x["need"] for x in live), reverse=True), "need": max(at[comp].values()),
                     "cache": max((x["cache"] for x in live), default=0), "ws": max((x["ws"] for x in live), default=0)}
    return out


def belongs(v, comp):
    """Whether a shape runs that component: PostgreSQL and the in-memory store stay up between shapes,
    and their idle memory must not be charged to a shape that does not use them."""
    b = v.split("+", 1)[0]
    if comp in ("postgres", "barman sidecar"):
        return b.startswith("v1-pg")
    if comp in ("valkey", "sentinel"):
        return b.startswith("v1-pg-cluster")
    if comp == "garage":
        return b.endswith("garage")
    return True


def variants(d):
    return sorted(x for x in os.listdir(d) if os.path.isdir(f"{d}/{x}") and x.startswith("v"))


def memory_section(run, vs):
    rows = []
    for v in vs:
        peaks = mem_peaks(run, v, ["append", "smtp", "mixed", "imap-read", "jmap-read"])
        for comp in ("stalwart", "postgres", "barman sidecar", "valkey", "sentinel", "garage"):
            m = peaks.get(comp)
            if not m or not m["pods"] or not belongs(v, comp):
                continue
            rows.append([v, comp, len(m["pods"]), " / ".join(gib(x) for x in m["pods"]), gib(m["need"]),
                         gib(m["cache"]), gib(m["ws"])])
    return ["## Memory per component (GiB, peak over ingest, mixed load and reads)", "",
            table(["shape", "component", "pods", "need per pod (anon+shmem+kernel)", "need, all pods at once",
                   "page cache, largest pod", "working set, largest pod"], rows), "",
            "*need* is what the component holds and cannot give back: process memory plus "
            "PostgreSQL's shared buffers (shmem) plus kernel memory. Page cache comes on top up to the "
            "limit and is reclaimed under pressure.", ""]


def storage_section(run, vs, prod_bytes):
    """At rest. pg_wal is a fixed allowance (min_wal_size … max_wal_size, 0.5–4 GB here), not a share of
    the mail, so it is kept apart when the shape is scaled to production: production's raw mail is its
    0.16 store divided by 0.16's own store/raw ratio from the same run."""
    rows = []
    base = run.size("v016-rocks", "settled")
    ref = None
    if base:
        a, sm = run.phase("v016-rocks", "append"), run.phase("v016-rocks", "smtp")
        raw0 = ((a or {}).get("bytes") or 0) + ((sm or {}).get("bytes") or 0)
        ref = (base.get("data_alloc") or 0) / raw0 if raw0 else None
    prod_raw = prod_bytes / ref if ref else None
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
        scalable = (s.get("data_alloc") or 0) + (s.get("blob_alloc") or 0) + (pg_alloc - pg_wal) + garage
        prod = f"{scalable / raw * prod_raw / 1e9:.0f}" + (f" + {pg_wal / 1e9:.1f} WAL" if pg_wal else "") \
            if raw and prod_raw else "–"
        rows.append([v, gib(raw), gib(s.get("data_alloc")), gib(s.get("blob_alloc")), s.get("blob_files"),
                     f"{len(inst)} × {gib((pg_alloc - pg_wal) / len(inst))}" if inst else "–",
                     f"{len(inst)} × {gib(pg_wal / len(inst))}" if inst else "–",
                     gib(garage) if garage else "–", gib(scalable + pg_wal),
                     round(scalable / raw, 2) if raw else None, prod])
    note = (f"Production's raw mail = its 0.16 store on disk ({prod_bytes / 1e9:.1f} GB, 2026-10-31) ÷ 0.16's "
            f"store/raw ratio here ({ref:.3f}) = {prod_raw / 1e9:.1f} GB." if prod_raw else "")
    return ["## Total storage, store at rest (GiB allocated on disk)", "",
            table(["shape", "raw mail", "data dir", "blob dir", "blob files", "PostgreSQL data per instance",
                   "pg_wal per instance", "Garage volumes", "total", "total without pg_wal / raw",
                   "at production's size (GB)"], rows), "",
            "Allocated blocks (`du -B1`): a 2 KB file takes a 4 KiB block. " + note, ""]


def backup_section(run, vs):
    """Rates from the tools' own counts (fetched / imported): a run that failed part-way is not a fast one."""
    rows, rest = [], []
    checks = jsonl(f"{run.d}/restore-check.jsonl")
    for v in vs:
        bk = [b for b in jsonl(f"{run.d}/backup.jsonl") if b.get("variant") == v]
        if not bk:
            continue
        repo = next((b for b in bk if b.get("step") == "restic-repo"), {})
        for step in ("capture", "restore"):
            for engine in ("imap", "jmap"):
                xs = [b for b in bk if b.get("step") == step and b.get("engine") == engine]
                if not xs:
                    continue
                key = "fetched" if step == "capture" else "imported"

                def rate(bs):
                    n = sum((b.get("summary") or {}).get(key) or 0 for b in bs)
                    t = sum(float(b["seconds"]) for b in bs)
                    return f"{n / t:.0f}" if n and t else "–"
                big = [b for b in xs if b["mailbox"] == "big"]
                small = [b for b in xs if b["mailbox"] != "big"]
                failed = sum((b.get("summary") or {}).get("failed") or 0 for b in xs)
                done = sum((b.get("summary") or {}).get(key) or 0 for b in xs)
                ok = [c for c in checks if c["variant"] == v and c["engine"] == engine]
                rows.append([v, step, engine, rate(big), rate(small), done, failed or "–",
                             f"{sum(c['identical'] for c in ok)}/{len(ok)}" if step == "restore" else "–"])
        rb = [b for b in bk if b.get("step") == "restic-backup"]
        rr = next((b for b in bk if b.get("step") == "restic-restore"), None)
        if rb:
            rest.append([v, round(sum(float(b["seconds"]) for b in rb), 1), gib(repo.get("capture_bytes")),
                         gib(repo.get("bytes")), rr and rr["seconds"]])
    return ["## Mailbox backup and restore — the platform's tools (msg/s)", "",
            table(["shape", "step", "engine", "large mailbox", "five small, one after another",
                   "messages done", "failed", "restored identical"], rows), "",
            "IMAP engine = production (imap-sync.py one connection; imap-restore.py MULTIAPPEND, 4 "
            "connections). JMAP engine = the legacy scripts the image still carries (jmap-sync.py 8 "
            "download workers, at most 20,000 messages per mailbox and run; jmap-restore.py 16 workers). "
            "*Identical*: every folder's messages, flags, keywords, INTERNALDATE and sizes match the source "
            "(UIDs aside).", "",
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
