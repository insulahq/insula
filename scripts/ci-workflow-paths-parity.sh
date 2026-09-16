#!/usr/bin/env bash
#
# A workflow's `push:` and `pull_request:` path filters must match.
#
# Why this guard exists
# --------------------
# When the two lists drift, a guard runs on the branch AFTER merge but sits out
# the PR that introduced the change — which is exactly when it needed to block.
# The failure is invisible: the PR goes green with a smaller set of checks, and
# nobody counts checks.
#
# Found live 2026-09-15: `backend/src/db/migrations/**` was on ci-infrastructure's
# push trigger but not its pull_request trigger, so PR #579 — a migration plus a
# doc — never ran ci-migration-safety-check.sh, the guard whose entire job is
# gating migrations. ci-infrastructure.yml already carried three comments about
# this same class of miss (the #391 lesson, the notification matrix across four
# PRs, an SC2034 in a host migration); each fixed one list at a time.
#
# Deliberately compares SETS, not order: a reordered list is not a defect.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 unavailable"; exit 0; }

python3 - <<'PY'
import sys, glob
try:
    import yaml
except ModuleNotFoundError:
    print("SKIP: PyYAML unavailable")
    sys.exit(0)

bad = []
checked = 0
for path in sorted(glob.glob('.github/workflows/*.yml') + glob.glob('.github/workflows/*.yaml')):
    try:
        doc = yaml.safe_load(open(path, encoding='utf-8'))
    except Exception as e:                      # noqa: BLE001 - report, don't crash CI
        print(f"WARN: could not parse {path}: {e}")
        continue
    if not isinstance(doc, dict):
        continue
    # `on:` parses as the boolean True in YAML 1.1
    on = doc.get(True, doc.get('on'))
    if not isinstance(on, dict):
        continue
    push, pr = on.get('push'), on.get('pull_request')
    if not isinstance(push, dict) or not isinstance(pr, dict):
        continue
    # Only meaningful when BOTH filter by path. A trigger with no `paths:` runs
    # on everything, which is broader, not narrower — never a missed guard.
    if 'paths' not in push or 'paths' not in pr:
        continue
    checked += 1
    only_push = set(push['paths']) - set(pr['paths'])
    only_pr = set(pr['paths']) - set(push['paths'])
    if only_push or only_pr:
        bad.append((path, sorted(only_push), sorted(only_pr)))

if bad:
    print("FAIL: push/pull_request path filters disagree — a guard will sit out the PR it should block.\n")
    for path, op, opr in bad:
        print(f"  {path}")
        if op:
            print(f"    on push but NOT pull_request: {', '.join(op)}")
            print("      -> a PR touching only these runs FEWER checks than the merge will.")
        if opr:
            print(f"    on pull_request but NOT push: {', '.join(opr)}")
    sys.exit(1)

print(f"OK: {checked} workflow(s) filter both triggers, and their path lists match.")
PY
