#!/usr/bin/env bash
#
# CI guard — no dates in code comments.
#
# Why this guard exists
# ---------------------
# This repository is public. Its comments had accumulated 2127 dated lines
# across 772 files, and a large share of them narrated incidents: when a pod
# was OOM-killed and how often, which volume carried how many gigabytes of
# dead blocks, which recovery was only possible because of which setting. Read
# together, that told anyone what breaks in this product, when, and how
# fragile it was — which is not what a comment is for.
#
# Operator decision: the incident detail lives in the private
# `insulahq/insula-ops` repo. A comment here keeps the CONSTRAINT and, where
# useful, an `OPS-` reference:
#
# WRONG // Bumped after the fresh install broke: the literal
#          // "${CLUSTER_ISSUER_NAME:=…}" reached issuerRef.name and no cert issued.
#   RIGHT  // MUST be the bare ${VAR} form — a `:=` default survives bootstrap's
#          // envsubst literally and lands in issuerRef.name. See OPS-31.
#
# The date is what this guard can detect mechanically. It is a proxy for the
# narrative, not the harm itself — a dateless incident story passes, so review
# still matters.
#
# Scope: comments in code only. Deliberately NOT covered, because a date is
# load-bearing there:
#   * CHANGELOG.md and docs/ prose — dated records by design
#   * ADRs (`**Date:**` headers) — the decision-record format requires it
#   * code, string literals, test fixtures, migration filenames
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "── no dated comments guard ──────────────────────────────────────────"

python3 - "$REPO_ROOT" <<'PY'
import os, re, sys

root = sys.argv[1]
DATE = re.compile(r'\b20\d{2}-\d{2}(?:-\d{2})?\b')

TREES = [
    ('backend/src', ('.ts', '.tsx')),
    ('frontend', ('.ts', '.tsx')),
    ('scripts', ('.sh',)),
    ('k8s', ('.yaml', '.yml')),
]

def comment_body(line: str, ext: str):
    """The comment text on this line, or None when the line is not a comment.

    Deliberately conservative: only whole-line comments are inspected. A date
    inside a string literal on a code line is not a comment and must not be
    flagged — that is test data, a migration name or an API default.
    """
    s = line.strip()
    if ext in ('.ts', '.tsx'):
        if s.startswith('//'):
            return s[2:]
        if s.startswith('*') or s.startswith('/*'):
            return s.lstrip('/*')
    if ext in ('.yaml', '.yml', '.sh') and s.startswith('#'):
        return s[1:]
    return None

failures = []
scanned = 0
for tree, exts in TREES:
    base = os.path.join(root, tree)
    if not os.path.isdir(base):
        continue
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d != 'node_modules']
        for fn in filenames:
            if os.path.splitext(fn)[1] not in exts:
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, root)
            try:
                with open(path, encoding='utf-8') as fh:
                    lines = fh.read().split('\n')
            except (OSError, UnicodeDecodeError):
                continue
            scanned += 1
            for n, line in enumerate(lines, 1):
                body = comment_body(line, os.path.splitext(fn)[1])
                if body is None:
                    continue
                m = DATE.search(body)
                if m:
                    failures.append((rel, n, m.group(0), ' '.join(body.split())[:96]))

if scanned == 0:
    print('FAIL: scanned no files — the tree list is wrong and this guard', file=sys.stderr)
    print('      would pass trivially.', file=sys.stderr)
    sys.exit(1)

if failures:
    print(f'FAIL: {len(failures)} dated comment(s) in {scanned} scanned files:\n', file=sys.stderr)
    for rel, n, date, text in failures[:40]:
        print(f'  {rel}:{n}  [{date}]  {text}', file=sys.stderr)
    if len(failures) > 40:
        print(f'  … and {len(failures) - 40} more', file=sys.stderr)
    print("""
This repository is public. Keep the CONSTRAINT in the comment and move the
incident — the date, the environment, the measurements — to the private
insulahq/insula-ops repo, referencing it as OPS-<id> if the comment needs a
pointer.

A date that is genuinely load-bearing (a changelog entry, an ADR header,
a test fixture) does not belong in a code comment in the first place.
""", file=sys.stderr)
    sys.exit(1)

print(f'OK: {scanned} files scanned — no dates in code comments.')
PY
