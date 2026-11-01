#!/usr/bin/env python3
"""sampler.py <namespace> <out.jsonl> [interval] [node] — every interval seconds, one line per
container of the namespace's pods: cumulative CPU (core-nanoseconds), working set and RSS from
the kubelet summary API, plus the container's cgroup memory.stat split (anon, shmem, page cache,
kernel). Runs on a cluster node as root (k3s kubectl, /sys/fs/cgroup); on a multi-node cluster it
reads the summary of every node and the cgroups of the node it runs on only — or, given [node],
that node alone: one sampler per node (samples-<node>.jsonl) gives the split everywhere.

Why the split: the kubelet's rssBytes is the cgroup's anon memory, which leaves out PostgreSQL's
shared_buffers (shmem), and its working set counts active page cache, which the kernel reclaims
under pressure. The memory a component needs is anon + shmem + kernel ("need" in the output);
page cache ("cache") is what it can use on top.

report.py turns the cumulative CPU into CPU-seconds per phase and takes the peak memory.
"""
import glob
import json
import subprocess
import sys
import time

STAT_KEYS = ("anon", "file", "shmem", "kernel", "active_file", "inactive_file")


def kubectl(*args: str, timeout: int = 20) -> str:
    return subprocess.run(["k3s", "kubectl", *args], capture_output=True, text=True,
                          timeout=timeout, check=True).stdout


def cgroup_dir(cid: str, cache: dict[str, str | None]) -> str | None:
    """The cgroup directory of a container on this node (None when it runs elsewhere)."""
    if cid not in cache:
        hits = glob.glob(f"/sys/fs/cgroup/kubepods*/**/*{cid}*.scope", recursive=True) or \
            glob.glob(f"/sys/fs/cgroup/kubepods*/**/{cid}", recursive=True)
        cache[cid] = hits[0] if hits else None
    return cache[cid]


def memory_split(path: str) -> dict[str, int]:
    stat: dict[str, int] = {}
    with open(f"{path}/memory.stat") as f:
        for line in f:
            key, _, value = line.partition(" ")
            if key in STAT_KEYS:
                stat[key] = int(value)
    with open(f"{path}/memory.current") as f:
        current = int(f.read())
    shmem = stat.get("shmem", 0)
    return {"current": current, "anon": stat.get("anon", 0), "shmem": shmem,
            "kernel": stat.get("kernel", 0), "cache": stat.get("file", 0) - shmem,
            "need": stat.get("anon", 0) + shmem + stat.get("kernel", 0)}


def container_ids(ns: str) -> dict[tuple[str, str], str]:
    pods = json.loads(kubectl("-n", ns, "get", "pods", "-o", "json"))
    ids: dict[tuple[str, str], str] = {}
    for pod in pods.get("items", []):
        for cs in pod.get("status", {}).get("containerStatuses", []) or []:
            cid = (cs.get("containerID") or "").split("://")[-1]
            if cid:
                ids[(pod["metadata"]["name"], cs["name"])] = cid
    return ids


def main() -> None:
    ns, out = sys.argv[1], sys.argv[2]
    interval = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0
    nodes = [sys.argv[4]] if len(sys.argv) > 4 else \
        kubectl("get", "nodes", "-o", "jsonpath={.items[*].metadata.name}").split()
    cgroups: dict[str, str | None] = {}
    with open(out, "a", buffering=1) as f:
        while True:
            t = time.time()
            try:
                ids = container_ids(ns)
                for node in nodes:
                    try:
                        summary = json.loads(kubectl("get", "--raw", f"/api/v1/nodes/{node}/proxy/stats/summary"))
                    except subprocess.SubprocessError:
                        continue  # a node that is down (failover tests) or a fake one
                    f.write(json.dumps({"t": round(t, 1), "pod": "_node", "container": "_node", "node": node,
                                        "cpu_ns": summary["node"]["cpu"].get("usageCoreNanoSeconds"),
                                        "ws": summary["node"]["memory"].get("workingSetBytes")}) + "\n")
                    for pod in summary.get("pods", []):
                        if pod["podRef"]["namespace"] != ns:
                            continue
                        for c in pod.get("containers", []):
                            cpu, mem = c.get("cpu", {}), c.get("memory", {})
                            row = {"t": round(t, 1), "pod": pod["podRef"]["name"], "container": c["name"],
                                   "node": node, "cpu_ns": cpu.get("usageCoreNanoSeconds"),
                                   "ws": mem.get("workingSetBytes"), "rss": mem.get("rssBytes")}
                            cid = ids.get((pod["podRef"]["name"], c["name"]))
                            path = cgroup_dir(cid, cgroups) if cid else None
                            if path:
                                try:
                                    row["mem"] = memory_split(path)
                                except OSError:
                                    cgroups.pop(cid, None)  # the container restarted
                            f.write(json.dumps(row) + "\n")
            except (subprocess.SubprocessError, ValueError, KeyError) as exc:
                f.write(json.dumps({"t": round(t, 1), "error": str(exc)[:200]}) + "\n")
            time.sleep(max(0.0, interval - (time.time() - t)))


if __name__ == "__main__":
    main()
