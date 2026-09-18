#!/usr/bin/env bash
#
# Guard: backup-health discovery labels must sit on spec.jobTemplate.metadata.
#
# The backup-health scheduler (backend/src/modules/backup-health/service.ts)
# selects **Jobs** cluster-wide with `insula.host/backup-health-watch=true`. The
# Kubernetes CronJob controller builds each Job's ObjectMeta from
# `spec.jobTemplate.metadata` ONLY — labels on the CronJob's own metadata are
# never copied. A CronJob labelled in the wrong place is therefore invisible to
# the watcher, and nothing fails: the scheduler lists an empty set every tick and
# notifies on nothing, forever.
#
# That is not hypothetical. Proven on DEV: three labelled, unsuspended
# CronJobs firing normally, and
#     kubectl get jobs -A -l insula.host/backup-health-watch=true
#     No resources found
# The scheduler's unit tests mock the lister, so they stayed green throughout.
#
# Checks, for every CronJob manifest that mentions the label at all:
#   1. spec.jobTemplate.metadata.labels carries backup-health-watch: "true"
#   2. backup-category is one of the values labels.ts parses
#   3. backup-severity, if present, is one it parses
#   4. a display-name annotation exists (it is what the UI and the notification
#      body call the job; without it they render a bare namespace/name)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mapfile -t FILES < <(grep -rl "insula.host/backup-health-watch" \
  --include="*.yaml" --include="*.yml" k8s/ 2>/dev/null | sort)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "ci-backup-health-label-check: no manifests reference the label"
  echo "  If backup-health discovery is still a feature, this is a REGRESSION:"
  echo "  every watched CronJob lost its labels and nothing is being monitored."
  exit 1
fi

python3 - "${FILES[@]}" <<'PY'
import sys, yaml

WATCH = 'insula.host/backup-health-watch'
CATEGORY = 'insula.host/backup-category'
SEVERITY = 'insula.host/backup-severity'
DISPLAY = 'insula.host/backup-display-name'

# Keep in sync with backend/src/modules/backup-health/labels.ts. A value outside
# these sets does not fail — parseCategory/parseSeverity silently coerce it to
# 'custom'/'warning' — which is exactly why it is worth catching here.
CATEGORIES = {'dr', 'tenant', 'audit', 'custom'}

# Comment marker a Flux-disowned CronJob must carry, naming the reconciler
# that converges its labels onto existing clusters.
RECONCILER_MARKER = 'backup-health-labels-reconciled-by:'
SEVERITIES = {'critical', 'warning', 'info'}

problems = []
checked = 0

for path in sys.argv[1:]:
    try:
        docs = [d for d in yaml.safe_load_all(open(path)) if isinstance(d, dict)]
    except yaml.YAMLError as e:
        problems.append(f"{path}: not parseable as YAML: {e}")
        continue

    for doc in docs:
        if doc.get('kind') != 'CronJob':
            continue
        name = (doc.get('metadata') or {}).get('name', '<unnamed>')
        spec = doc.get('spec') or {}
        jt = spec.get('jobTemplate') or {}
        jt_meta = jt.get('metadata') or {}
        jt_labels = jt_meta.get('labels') or {}
        jt_annots = jt_meta.get('annotations') or {}
        cj_labels = (doc.get('metadata') or {}).get('labels') or {}

        mentions = WATCH in jt_labels or WATCH in cj_labels
        if not mentions:
            continue
        checked += 1
        where = f"{path}: CronJob/{name}"

        if jt_labels.get(WATCH) != 'true':
            if cj_labels.get(WATCH) == 'true':
                problems.append(
                    f"{where}: {WATCH} is on the CronJob's OWN metadata but NOT on "
                    f"spec.jobTemplate.metadata.labels. The controller does not copy it, "
                    f"so the Jobs this CronJob creates carry no health-watch label and the "
                    f"scheduler will never see them."
                )
            else:
                problems.append(f"{where}: {WATCH} must be \"true\" on spec.jobTemplate.metadata.labels")
            continue

        cat = jt_labels.get(CATEGORY)
        if cat is None:
            problems.append(f"{where}: missing {CATEGORY} on the job template (drives UI grouping + notification routing)")
        elif cat not in CATEGORIES:
            problems.append(f"{where}: {CATEGORY}={cat!r} is not one of {sorted(CATEGORIES)} — labels.ts silently coerces it to 'custom'")

        sev = jt_labels.get(SEVERITY)
        if sev is not None and sev not in SEVERITIES:
            problems.append(f"{where}: {SEVERITY}={sev!r} is not one of {sorted(SEVERITIES)} — labels.ts silently coerces it to 'warning'")

        if not jt_annots.get(DISPLAY):
            problems.append(f"{where}: missing {DISPLAY} annotation on the job template")

        # A Flux-disowned CronJob never receives manifest edits on an EXISTING
        # cluster — kustomize-controller reports "skipped" for it forever, so the
        # labels above only ever reach a fresh install. Caught on DEV
        # etcd-snap-via-shim's manifest carried the block while the
        # live object's spec.jobTemplate.metadata was {}. Such a CronJob needs a
        # reconciler that converges the labels, and the manifest must say which.
        annots = (doc.get('metadata') or {}).get('annotations') or {}
        if annots.get('kustomize.toolkit.fluxcd.io/reconcile') == 'disabled':
            if RECONCILER_MARKER not in open(path).read():
                problems.append(
                    f"{where}: carries kustomize.toolkit.fluxcd.io/reconcile=disabled, so Flux "
                    f"SKIPS it on every apply and these labels will never reach an existing "
                    f"cluster. A reconciler must converge them; name it in this file with a "
                    f"'{RECONCILER_MARKER}' comment."
                )

if problems:
    print("ci-backup-health-label-check FAILED\n")
    for p in problems:
        print(f"  ✗ {p}")
    print("\n  Labels belong under spec.jobTemplate.metadata — and a Flux-disowned CronJob")
    print("  additionally needs a reconciler, because Flux never re-applies it.")
    sys.exit(1)

if checked == 0:
    print("ci-backup-health-label-check: files mention the label but no CronJob uses it — check the grep")
    sys.exit(1)

print(f"ci-backup-health-label-check: OK ({checked} watched CronJob(s) label their job template)")
PY
