#!/usr/bin/env python3
"""release-workload-changes.py — what an upgrade to this release restarts, per earlier release.

The upgrade review (ADR-064 §6) says what an upgrade interrupts. The platform's own
services (management API, panels) are read live from the cluster; everything else Flux
applies — the mail server, webmail, the platform database, the reconcilers — restarts
only when the release changes what its pods run. Nothing on the cluster knows that
before the new manifests are applied, so the release says it: this script renders the
production overlay of the release being cut and of each earlier tag with ONE kustomize
(so both sides of every comparison come from the same tool), and lists, for each earlier
version, the workloads whose rollout-relevant spec differs. release.yml signs the result
into release-manifest.json as `workloadChanges`; the review looks up the installed version.

What counts as a restart — when in doubt it counts, because a restart the review does not
mention is worse than one it mentions needlessly:
  - Deployment / StatefulSet / DaemonSet: its pod template changed, or a ConfigMap that
    Reloader restarts it for (configmap.reloader.stakater.com/reload, or
    reloader.stakater.com/auto + the ConfigMaps the pods reference) changed. A workload
    with updateStrategy OnDelete is listed when it is added or removed, never for a
    template change: that does not restart it.
  - The CNPG Cluster: any change to its spec except the fields known not to restart the
    instances (CLUSTER_NO_RESTART), and of its PostgreSQL settings only those that take
    effect at start (RESTART_PARAMETERS) — the rest are reloaded.
Secrets are not in git (bootstrap writes them), so a Secret change is never seen here.

Which earlier releases: the `--max-earlier` newest stable tags before this release, plus
every release candidate newer than the fifth-newest of those (the installs that run an rc:
staging, and a cluster mid-way through a release cycle).

Usage:
  release-workload-changes.py --version 2026.10.10 [--root DIR] [--max-earlier 40]
                              [--kustomize "kustomize build"] [--current-ref TAG]
The release's own overlay is read from the working tree — release.yml runs on the tag,
whose production overlay cut-release.sh has stamped. --current-ref reads it from a tag
instead (a development checkout carries placeholder pins, so compare stamped trees).
Prints {"<earlier version>": [{"kind","namespace","name","change"}...], ...} on stdout,
change = restart | added | removed. Exits 1 when this release's overlay does not render,
names a workload the review's schema would drop, or when no earlier tag renders at all;
a single earlier tag that does not render is left out (the review then says it cannot tell).
"""
import argparse
import hashlib
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile

import yaml

OVERLAY = "k8s/overlays/production"
POD_WORKLOADS = ("Deployment", "StatefulSet", "DaemonSet")
TAG_RE = re.compile(r"^v(\d{4})\.(\d{1,2})\.(\d+)(?:-rc\.(\d+))?$")
# The review's schema (packages/api-contracts releaseWorkloadChangeSchema) drops an entry
# that does not match these — so a key that would not match fails the release instead.
NAMESPACE_RE = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
NAME_RE = re.compile(r"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$")
RC_WINDOW_STABLES = 5

# PostgreSQL 18's `context = 'postmaster'` settings — the ones a change of which needs a
# restart. Read from PostgreSQL 18.6 itself:
#   select name from pg_settings where context = 'postmaster' order by name;
# Every other parameter is reloaded (CNPG signals the instances) without a restart.
RESTART_PARAMETERS = frozenset("""
archive_mode autovacuum_freeze_max_age autovacuum_multixact_freeze_max_age
autovacuum_worker_slots bonjour bonjour_name cluster_name commit_timestamp_buffers
config_file data_directory data_sync_retry debug_io_direct dynamic_shared_memory_type
event_source external_pid_file hba_file hot_standby huge_page_size huge_pages ident_file
ignore_invalid_pages io_max_combine_limit io_max_concurrency io_method jit_provider
listen_addresses logging_collector max_active_replication_origins max_connections
max_files_per_process max_locks_per_transaction max_logical_replication_workers
max_notify_queue_pages max_pred_locks_per_transaction max_prepared_transactions
max_replication_slots max_wal_senders max_worker_processes min_dynamic_shared_memory
multixact_member_buffers multixact_offset_buffers notify_buffers port recovery_target
recovery_target_action recovery_target_inclusive recovery_target_lsn recovery_target_name
recovery_target_time recovery_target_timeline recovery_target_xid reserved_connections
serializable_buffers shared_buffers shared_memory_type shared_preload_libraries
subtransaction_buffers superuser_reserved_connections trace_connection_negotiation
track_activity_query_size track_commit_timestamp transaction_buffers
unix_socket_directories unix_socket_group unix_socket_permissions wal_buffers
wal_decode_buffer_size wal_level wal_log_hints
""".split())

# CNPG Cluster spec fields whose change does NOT roll the instances: the instance count,
# monitoring, backups, managed roles, first-init bootstrap, external cluster definitions,
# update/failover policy and timing, superuser access, synchronous-replica bounds,
# replication slots, the operator's log level; `storage`/`walStorage` (a bigger size is
# grown in place — resizeInUseVolumes defaults on — and a class or template applies to new
# volumes only) and `inheritedMetadata` (labels and annotations are patched onto the running
# pods). Every OTHER field counts as a restart.
CLUSTER_NO_RESTART = frozenset((
    "instances", "monitoring", "backup", "managed", "bootstrap", "externalClusters", "description",
    "primaryUpdateStrategy", "primaryUpdateMethod", "failoverDelay", "switchoverDelay",
    "enableSuperuserAccess", "superuserSecret", "minSyncReplicas", "maxSyncReplicas",
    "replicationSlots", "logLevel", "storage", "walStorage", "inheritedMetadata",
))
# Within spec.postgresql: host-based auth, ident maps, LDAP and synchronous-replication
# settings are reloaded; `parameters` are filtered to RESTART_PARAMETERS. The rest counts.
POSTGRESQL_NO_RESTART = frozenset(("pg_hba", "pg_ident", "ldap", "synchronous", "promotionTimeout"))


def version_key(version):
    """Sort key for a CalVer version (2026.10.9, 2026.10.9-rc.2); None when it is not one."""
    m = TAG_RE.match("v" + version)
    if not m:
        return None
    y, mo, p, rc = m.groups()
    return (int(y), int(mo), int(p), 0 if rc is not None else 1, int(rc or 0))


def earlier_tags(tags, version, limit):
    """The `limit` newest stable tags before `version`, plus every rc tag newer than the
    RC_WINDOW_STABLES-th newest of them — newest first."""
    current = version_key(version)
    if current is None:
        raise ValueError(f"not a release version: {version}")
    older = sorted(((version_key(t[1:]), t) for t in tags if t.startswith("v") and version_key(t[1:]) is not None
                    and version_key(t[1:]) < current), reverse=True)
    stables = [(k, t) for k, t in older if "-rc." not in t][:limit]
    if not stables:
        return [t for _, t in older if "-rc." in t][:limit]
    rc_floor = stables[min(RC_WINDOW_STABLES, len(stables)) - 1][0]
    rcs = [(k, t) for k, t in older if "-rc." in t and k > rc_floor]
    return [t for _, t in sorted(stables + rcs, reverse=True)]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _csv(value):
    return [s.strip() for s in str(value or "").split(",") if s.strip()]


def referenced_configmaps(template):
    """Every ConfigMap a pod template mounts or reads env from."""
    spec = (template or {}).get("spec") or {}
    names = set()
    for vol in spec.get("volumes") or []:
        if (vol.get("configMap") or {}).get("name"):
            names.add(vol["configMap"]["name"])
        for src in ((vol.get("projected") or {}).get("sources") or []):
            if (src.get("configMap") or {}).get("name"):
                names.add(src["configMap"]["name"])
    for c in (spec.get("containers") or []) + (spec.get("initContainers") or []):
        for ef in c.get("envFrom") or []:
            if (ef.get("configMapRef") or {}).get("name"):
                names.add(ef["configMapRef"]["name"])
        for e in c.get("env") or []:
            ref = ((e.get("valueFrom") or {}).get("configMapKeyRef") or {}).get("name")
            if ref:
                names.add(ref)
    return names


def reloaded_configmaps(doc):
    """The ConfigMaps whose change Reloader restarts this workload for."""
    ann = (doc.get("metadata") or {}).get("annotations") or {}
    names = set(_csv(ann.get("configmap.reloader.stakater.com/reload")))
    if str(ann.get("reloader.stakater.com/auto", "")).lower() == "true" or \
            str(ann.get("configmap.reloader.stakater.com/auto", "")).lower() == "true":
        names |= referenced_configmaps((doc.get("spec") or {}).get("template"))
    return names


def cluster_restart_view(spec):
    """The part of a CNPG Cluster spec whose change rolls the instances."""
    view = {k: v for k, v in spec.items() if k not in CLUSTER_NO_RESTART and k != "postgresql"}
    pg = spec.get("postgresql") or {}
    view["postgresql"] = {k: v for k, v in pg.items() if k not in POSTGRESQL_NO_RESTART and k != "parameters"}
    view["postgresql"]["parameters"] = {k: v for k, v in (pg.get("parameters") or {}).items() if k in RESTART_PARAMETERS}
    return view


def fingerprints(docs):
    """{ "Kind/namespace/name": sha256 of what a restart depends on } for one rendered overlay."""
    configmaps = {}
    for d in docs:
        if d.get("kind") == "ConfigMap":
            md = d.get("metadata") or {}
            configmaps[(md.get("namespace", ""), md.get("name", ""))] = {"data": d.get("data"), "binaryData": d.get("binaryData")}
    out = {}
    for d in docs:
        kind = d.get("kind")
        md = d.get("metadata") or {}
        ns, name = md.get("namespace", ""), md.get("name", "")
        spec = d.get("spec") or {}
        if kind in POD_WORKLOADS:
            if (spec.get("updateStrategy") or {}).get("type") == "OnDelete":
                # Present, so adding or removing it is listed; constant, so a template change is not.
                out[f"{kind}/{ns}/{name}"] = digest({"onDelete": True})
                continue
            reloads = {cm: configmaps.get((ns, cm)) for cm in sorted(reloaded_configmaps(d))}
            out[f"{kind}/{ns}/{name}"] = digest({"template": spec.get("template"), "reloads": reloads})
        elif kind == "Cluster" and str(d.get("apiVersion", "")).startswith("postgresql.cnpg.io/"):
            out[f"{kind}/{ns}/{name}"] = digest(cluster_restart_view(spec))
    return out


def invalid_keys(fps):
    """Keys the review's schema would drop — a restart the operator would never see."""
    bad = []
    for key in fps:
        _, ns, name = key.split("/", 2)
        if not (len(ns) <= 63 and NAMESPACE_RE.match(ns) and len(name) <= 253 and NAME_RE.match(name)):
            bad.append(key)
    return sorted(bad)


def changes(old, new):
    """What moving from the `old` fingerprints to the `new` ones restarts, starts and removes."""
    items = []
    for key in sorted(set(old) | set(new)):
        if key in old and key in new:
            if old[key] == new[key]:
                continue
            change = "restart"
        else:
            change = "added" if key in new else "removed"
        kind, ns, name = key.split("/", 2)
        items.append({"kind": kind, "namespace": ns, "name": name, "change": change})
    return items


def render(kustomize, overlay_dir):
    out = subprocess.run(shlex.split(kustomize) + [overlay_dir], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:500] or f"{kustomize} exited {out.returncode}")
    return [d for d in yaml.safe_load_all(out.stdout) if isinstance(d, dict)]


def render_tag(root, tag, kustomize):
    """Render a tag's production overlay from `git archive` — the working tree is never touched."""
    archive = subprocess.run(["git", "-C", root, "archive", "--format=tar", tag, "k8s"], capture_output=True)
    if archive.returncode != 0:
        raise RuntimeError(archive.stderr.decode(errors="replace").strip()[:300])
    with tempfile.TemporaryDirectory(prefix="workload-changes-") as tmp:
        with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tar:
            tar.extractall(tmp, filter="data")
        return render(kustomize, os.path.join(tmp, OVERLAY))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--version", required=True, help="the release being cut, e.g. 2026.10.10")
    ap.add_argument("--root", default=".", help="repository root (default: .)")
    ap.add_argument("--max-earlier", type=int, default=40, help="how many earlier stable releases to compare with (default 40)")
    ap.add_argument("--kustomize", default=os.environ.get("KUSTOMIZE", "kubectl kustomize"),
                    help='the render command; the overlay directory is appended (default "kubectl kustomize")')
    ap.add_argument("--current-ref", help="read this release's overlay from a tag instead of the working tree")
    args = ap.parse_args(argv)

    current = fingerprints(render_tag(args.root, args.current_ref, args.kustomize) if args.current_ref
                           else render(args.kustomize, os.path.join(args.root, OVERLAY)))
    if not current:
        print("release-workload-changes: this release's overlay renders no workload", file=sys.stderr)
        return 1
    bad = invalid_keys(current)
    if bad:
        print(f"release-workload-changes: the review would drop these (namespace or name it cannot show): {', '.join(bad)}",
              file=sys.stderr)
        return 1
    tags = subprocess.run(["git", "-C", args.root, "tag", "--list", "v*"], capture_output=True, text=True, check=True).stdout.split()
    earlier = earlier_tags(tags, args.version, args.max_earlier)
    result = {}
    for tag in earlier:
        try:
            old = fingerprints(render_tag(args.root, tag, args.kustomize))
        except Exception as exc:  # an old tag that no longer renders: the review says it cannot tell
            print(f"release-workload-changes: {tag} left out — {exc}", file=sys.stderr)
            continue
        dropped = invalid_keys(old)
        if dropped:  # only something that tag had and this release no longer has can land here
            print(f"release-workload-changes: {tag}: not listing {', '.join(dropped)} (no valid namespace/name)", file=sys.stderr)
        result[tag[1:]] = changes({k: v for k, v in old.items() if k not in dropped}, current)
    if earlier and not result:
        print("release-workload-changes: no earlier release rendered — every upgrade would read 'cannot tell'", file=sys.stderr)
        return 1
    json.dump(result, sys.stdout, separators=(",", ":"))
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
