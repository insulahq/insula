#!/usr/bin/env python3
"""Tests for release-workload-changes.py (the upgrade review's "what restarts" table).

Plain-python (no pytest), matching the repo convention (scripts/test-trivy-helpers.py). Run:
    python3 scripts/test-release-workload-changes.py
Exit 0 = all pass, 1 = a failure. The last block builds a throwaway git repository with
two tags and a stand-in for kustomize, and runs the script end to end.
"""
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("rwc", os.path.join(HERE, "release-workload-changes.py"))
rwc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rwc)

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        failures.append(name)


def deploy(name, image, ns="mail", annotations=None, cm_volume=None, strategy=None, kind="Deployment"):
    pod = {"containers": [{"name": "c", "image": image}]}
    if cm_volume:
        pod["volumes"] = [{"name": "cfg", "configMap": {"name": cm_volume}}]
    d = {"apiVersion": "apps/v1", "kind": kind, "metadata": {"name": name, "namespace": ns, "annotations": annotations or {}},
         "spec": {"template": {"metadata": {"labels": {"app": name}}, "spec": pod}}}
    if strategy:
        d["spec"]["updateStrategy"] = {"type": strategy}
    return d


def configmap(name, data, ns="mail"):
    return {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": name, "namespace": ns}, "data": data}


def cluster(image="pg:18.3", params=None, resources=None):
    return {"apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster", "metadata": {"name": "system-db", "namespace": "platform"},
            "spec": {"imageName": image, "resources": resources or {"requests": {"memory": "256Mi"}},
                     "postgresql": {"parameters": params or {}}, "monitoring": {"enablePodMonitor": False}}}


def diff(old_docs, new_docs):
    return [(i["change"], i["name"]) for i in rwc.changes(rwc.fingerprints(old_docs), rwc.fingerprints(new_docs))]


# ── versions ──
check("rc sorts before its stable", rwc.version_key("2026.10.8-rc.4") < rwc.version_key("2026.10.8"))
check("rc.10 sorts after rc.9", rwc.version_key("2026.10.8-rc.10") > rwc.version_key("2026.10.8-rc.9"))
check("month 10 sorts after month 9", rwc.version_key("2026.10.1") > rwc.version_key("2026.9.38"))
check("a dev build is not a release version", rwc.version_key("2026.10.8-69ed428") is None)
tags = ["v2026.10.9", "v2026.10.8", "v2026.10.8-rc.4", "v2026.10.7", "v2026.9.38", "v2026.10.10", "vnot-a-tag", "other"]
check("earlier tags: strictly older, newest first, stable releases capped, recent rcs kept",
      rwc.earlier_tags(tags, "2026.10.9", 3) == ["v2026.10.8", "v2026.10.8-rc.4", "v2026.10.7", "v2026.9.38"])
many = [f"v2026.9.{p}" for p in range(1, 9)] + [f"v2026.9.{p}-rc.{r}" for p in range(1, 9) for r in (1, 2)]
picked = rwc.earlier_tags(many, "2026.10.1", 6)
check("rc tags count only within the five newest stable releases; the stable window is not eaten by rcs",
      [t for t in picked if "-rc." not in t] == [f"v2026.9.{p}" for p in range(8, 2, -1)]
      and sorted(t for t in picked if "-rc." in t) == sorted(f"v2026.9.{p}-rc.{r}" for p in range(5, 9) for r in (1, 2)))
check("an rc's earlier tags include the previous stable but not itself",
      rwc.earlier_tags(tags, "2026.10.8-rc.4", 5) == ["v2026.10.7", "v2026.9.38"])

# ── pod workloads ──
base = [deploy("stalwart-mail", "stalwart:0.16.24"), deploy("bulwark", "bulwark:1")]
check("an unchanged overlay restarts nothing", diff(base, copy.deepcopy(base)) == [])
bumped = [deploy("stalwart-mail", "stalwart:0.16.26"), deploy("bulwark", "bulwark:1")]
check("an image change restarts exactly that workload", diff(base, bumped) == [("restart", "stalwart-mail")])
check("a new workload is added, a gone one removed",
      diff(base, [deploy("stalwart-mail", "stalwart:0.16.24"), deploy("roundcube", "rc:1")]) == [("removed", "bulwark"), ("added", "roundcube")])
relabel = copy.deepcopy(base)
relabel[1]["metadata"]["labels"] = {"x": "y"}
check("a change outside the pod template (object labels) restarts nothing", diff(base, relabel) == [])

# Reloader: a named ConfigMap, the auto mode, and a ConfigMap nobody reloads on.
named = {"configmap.reloader.stakater.com/reload": "stalwart-config, other"}
r_old = [deploy("stalwart-mail", "s:1", annotations=named), configmap("stalwart-config", {"a": "1"})]
r_new = [deploy("stalwart-mail", "s:1", annotations=named), configmap("stalwart-config", {"a": "2"})]
check("a ConfigMap named in configmap.reloader…/reload restarts its workload", diff(r_old, r_new) == [("restart", "stalwart-mail")])
auto = {"reloader.stakater.com/auto": "true"}
a_old = [deploy("bulwark", "b:1", annotations=auto, cm_volume="bulwark-cfg"), configmap("bulwark-cfg", {"k": "1"})]
a_new = [deploy("bulwark", "b:1", annotations=auto, cm_volume="bulwark-cfg"), configmap("bulwark-cfg", {"k": "2"})]
check("reloader auto: a ConfigMap the pods mount restarts the workload", diff(a_old, a_new) == [("restart", "bulwark")])
n_old = [deploy("bulwark", "b:1", cm_volume="bulwark-cfg"), configmap("bulwark-cfg", {"k": "1"})]
n_new = [deploy("bulwark", "b:1", cm_volume="bulwark-cfg"), configmap("bulwark-cfg", {"k": "2"})]
check("without Reloader a mounted ConfigMap's change restarts nothing", diff(n_old, n_new) == [])
o_old = [deploy("agent", "a:1", kind="DaemonSet", strategy="OnDelete")]
o_new = [deploy("agent", "a:2", kind="DaemonSet", strategy="OnDelete")]
check("an OnDelete DaemonSet is not restarted by a template change", diff(o_old, o_new) == [])
check("an OnDelete DaemonSet the release adds is still listed", diff([], o_new) == [("added", "agent")])
rolling = [deploy("agent", "a:1", kind="DaemonSet", strategy="RollingUpdate")]
check("a RollingUpdate DaemonSet is", diff(rolling, [deploy("agent", "a:2", kind="DaemonSet", strategy="RollingUpdate")]) == [("restart", "agent")])

# ── the CNPG Cluster ──
check("a reloaded PostgreSQL setting (tcp_keepalives_idle) restarts nothing",
      diff([cluster()], [cluster(params={"tcp_keepalives_idle": "60"})]) == [])
check("a restart-only setting (max_connections) restarts the database",
      diff([cluster(params={"max_connections": "100"})], [cluster(params={"max_connections": "200"})]) == [("restart", "system-db")])
check("a new PostgreSQL image restarts the database", diff([cluster()], [cluster(image="pg:18.4")]) == [("restart", "system-db")])
check("new resources restart the database",
      diff([cluster()], [cluster(resources={"requests": {"memory": "512Mi"}})]) == [("restart", "system-db")])
mon = cluster()
mon["spec"]["monitoring"] = {"enablePodMonitor": True}
check("a change outside the restart fields (monitoring) restarts nothing", diff([cluster()], [mon]) == [])
tol = cluster()
tol["spec"]["tolerations"] = [{"key": "dedicated", "operator": "Exists"}]
check("a field nobody listed (tolerations) counts as a restart — unknown is not 'no restart'", diff([cluster()], [tol]) == [("restart", "system-db")])
hba = cluster()
hba["spec"]["postgresql"]["pg_hba"] = ["host all all 10.0.0.0/8 scram-sha-256"]
check("a pg_hba change is reloaded, not a restart", diff([cluster()], [hba]) == [])
inst = cluster()
inst["spec"]["instances"] = 3
check("scaling the instance count is not a restart of the running ones", diff([cluster()], [inst]) == [])
grow = cluster()
grow["spec"]["storage"] = {"size": "4Gi"}
grow["spec"]["inheritedMetadata"] = {"labels": {"x": "y"}}
check("a bigger volume and new inherited labels (2026.9.30 → 2026.9.31) are applied in place", diff([cluster()], [grow]) == [])
check("a Cluster of another API group is not read as the database",
      rwc.fingerprints([{**cluster(), "apiVersion": "cluster.x-k8s.io/v1beta1"}]) == {})

# ── a key the review's schema would drop ──
check("a workload with no namespace is flagged, not silently dropped",
      rwc.invalid_keys(rwc.fingerprints([{**deploy("x", "i:1"), "metadata": {"name": "x"}}])) == ["Deployment//x"])
check("valid keys are not flagged", rwc.invalid_keys(rwc.fingerprints(base)) == [])

# ── end to end: two tags in a throwaway repository, a stand-in for kustomize ──
with tempfile.TemporaryDirectory(prefix="rwc-test-") as repo:
    overlay = os.path.join(repo, "k8s", "overlays", "production")
    os.makedirs(overlay)
    # The stand-in renders an overlay directory by printing the all.json it holds as YAML.
    fake = 'python3 -c "import json,sys,yaml; print(yaml.safe_dump_all(json.load(open(sys.argv[1] + \'/all.json\'))))"'

    def write(docs):
        with open(os.path.join(overlay, "all.json"), "w") as f:
            json.dump(docs, f)

    def git(*args):
        subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "test@example.test")
    git("config", "user.name", "test")
    write([deploy("stalwart-mail", "s:1"), deploy("bulwark", "b:1"), cluster()])
    git("add", "-A")
    git("commit", "-q", "-m", "one")
    git("tag", "v2026.10.8")
    write([deploy("stalwart-mail", "s:2"), deploy("bulwark", "b:1"), cluster(params={"tcp_keepalives_idle": "60"})])
    git("commit", "-q", "-am", "two")
    git("tag", "v2026.10.9")
    write([deploy("stalwart-mail", "s:2"), deploy("bulwark", "b:2"), cluster(image="pg:18.4")])  # the working tree = 2026.10.10

    def run(*extra):
        return subprocess.run([sys.executable, os.path.join(HERE, "release-workload-changes.py"), "--root", repo, "--kustomize", fake, *extra],
                              capture_output=True, text=True)

    out = run("--version", "2026.10.10")
    got = json.loads(out.stdout) if out.returncode == 0 else {}
    names = {v: sorted(f"{i['change']}:{i['name']}" for i in items) for v, items in got.items()}
    check("e2e: one entry per earlier tag", sorted(got) == ["2026.10.8", "2026.10.9"])
    check("e2e: from 2026.10.9 the webmail and the database restart",
          names.get("2026.10.9") == ["restart:bulwark", "restart:system-db"])
    check("e2e: from 2026.10.8 the mail server restarts too",
          names.get("2026.10.8") == ["restart:bulwark", "restart:stalwart-mail", "restart:system-db"])
    ref = run("--version", "2026.10.9", "--current-ref", "v2026.10.9")
    got_ref = json.loads(ref.stdout) if ref.returncode == 0 else {}
    check("e2e: --current-ref reads the release from its tag, not the working tree",
          [(i["change"], i["name"]) for i in got_ref.get("2026.10.8", [])] == [("restart", "stalwart-mail")])
    bad = subprocess.run([sys.executable, os.path.join(HERE, "release-workload-changes.py"), "--root", repo,
                          "--kustomize", "false", "--version", "2026.10.10"], capture_output=True, text=True)
    check("e2e: this release's overlay failing to render exits 1", bad.returncode == 1)
    write([{**deploy("stalwart-mail", "s:3"), "metadata": {"name": "stalwart-mail"}}])  # no namespace
    nons = run("--version", "2026.10.10")
    check("e2e: a workload the review would drop fails the release, naming it",
          nons.returncode == 1 and "Deployment//stalwart-mail" in nons.stderr)

with tempfile.TemporaryDirectory(prefix="rwc-test-") as repo:
    overlay = os.path.join(repo, "k8s", "overlays", "production")
    os.makedirs(overlay)
    def git2(*args):
        subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)
    git2("init", "-q")
    git2("config", "user.email", "test@example.test")
    git2("config", "user.name", "test")
    with open(os.path.join(overlay, "all.json"), "w") as f:
        f.write("{ not json")  # this tag's overlay no longer renders
    git2("add", "-A")
    git2("commit", "-q", "-m", "broken")
    git2("tag", "v2026.10.8")
    with open(os.path.join(overlay, "all.json"), "w") as f:
        json.dump([deploy("stalwart-mail", "s:1")], f)
    gone = subprocess.run([sys.executable, os.path.join(HERE, "release-workload-changes.py"), "--root", repo, "--kustomize", fake,
                           "--version", "2026.10.9"], capture_output=True, text=True)
    check("e2e: when no earlier release renders at all, the release fails instead of shipping an empty list",
          gone.returncode == 1 and "no earlier release rendered" in gone.stderr)

print(f"\n{'all passed' if not failures else f'{len(failures)} failed'}")
sys.exit(1 if failures else 0)
