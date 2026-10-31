#!/usr/bin/env python3
"""sampler.py <namespace> <out.jsonl> [interval] — every interval seconds, one line per
container of the namespace's pods from the kubelet summary API: cumulative CPU
(core-nanoseconds), working set and RSS. Runs on a cluster node (k3s kubectl).

report.py turns the cumulative CPU into CPU-seconds per phase and takes the peak memory.
"""
import json
import subprocess
import sys
import time


def main() -> None:
    ns, out = sys.argv[1], sys.argv[2]
    interval = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0
    node = subprocess.run(["k3s", "kubectl", "get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"],
                          capture_output=True, text=True, check=True).stdout.strip()
    path = f"/api/v1/nodes/{node}/proxy/stats/summary"
    with open(out, "a", buffering=1) as f:
        while True:
            t = time.time()
            try:
                raw = subprocess.run(["k3s", "kubectl", "get", "--raw", path], capture_output=True,
                                     text=True, timeout=20, check=True).stdout
                summary = json.loads(raw)
                node_cpu = summary["node"]["cpu"].get("usageCoreNanoSeconds")
                node_mem = summary["node"]["memory"].get("workingSetBytes")
                f.write(json.dumps({"t": round(t, 1), "pod": "_node", "container": "_node",
                                    "cpu_ns": node_cpu, "ws": node_mem}) + "\n")
                for pod in summary.get("pods", []):
                    if pod["podRef"]["namespace"] != ns:
                        continue
                    for c in pod.get("containers", []):
                        cpu, mem = c.get("cpu", {}), c.get("memory", {})
                        f.write(json.dumps({
                            "t": round(t, 1), "pod": pod["podRef"]["name"], "container": c["name"],
                            "cpu_ns": cpu.get("usageCoreNanoSeconds"), "ws": mem.get("workingSetBytes"),
                            "rss": mem.get("rssBytes")}) + "\n")
            except (subprocess.SubprocessError, ValueError, KeyError) as exc:
                f.write(json.dumps({"t": round(t, 1), "error": str(exc)[:200]}) + "\n")
            time.sleep(max(0.0, interval - (time.time() - t)))


if __name__ == "__main__":
    main()
