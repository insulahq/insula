#!/usr/bin/env bash
#
# CI guard — `$$VAR` inside `$( … )` in a manifest Flux never renders.
#
# Why this guard exists
# ---------------------
# every etcd snapshot in off-site storage (24 of 24 on
# production) carried `"sha256":""` in its sidecar. No stored snapshot could be
# verified before a restore, and nothing had ever reported a problem: the job
# exited 0 every time.
#
# The cause is an interaction between two renderers:
#
#   * Flux's postBuild substitution collapses `$$` to `$`, which is why inline
#     shell in this repo is written `$${VAR}`. Manifests that ship
#     `kustomize.toolkit.fluxcd.io/reconcile: disabled` are SKIPPED by Flux, so
#     that collapsing never happens for them.
#   * The kubelet also collapses `$$` to `$` in container command/args — but it
#     leaves any `$( … )` span completely alone, because it cannot resolve the
#     span as a `$(VAR)` reference.
#
# So in a Flux-skipped manifest, `$$VAR` works everywhere EXCEPT inside a
# command substitution, where the shell receives a literal `$$` and expands it
# to its own PID:
#
#     SHA=$(sha256sum "$$name" | cut -d ' ' -f 1)
#     → sha256sum: can't open '1name': No such file or directory
#
# The fix is always the same shape: bind the value OUTSIDE the substitution,
# which renders correctly under both renderers.
#
#     f="$$name"; SHA=$(sha256sum "$f" | cut -d ' ' -f 1)
#
# Scope: ONLY manifests Flux skips. In a Flux-rendered manifest `$$VAR` inside
# `$( … )` is correct and required — Flux collapses it before the kubelet ever
# sees it — so flagging those would be wrong.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "── Flux-skipped manifests: shell escaping guard ─────────────────────"

python3 - "$REPO_ROOT" <<'PY'
import os, re, sys

root = sys.argv[1]
k8s_dir = os.path.join(root, 'k8s')

# A manifest Flux will not render: it carries the reconcile:disabled annotation.
SKIP_MARKER = re.compile(r'kustomize\.toolkit\.fluxcd\.io/reconcile:\s*["\']?disabled')
# A command substitution, allowing one level of nested parens.
SUBST = re.compile(r'\$\((?:[^()]|\([^()]*\))*\)')
# `$$VAR` / `$${VAR}` — the escaping that only Flux collapses.
DOLLAR_DOLLAR = re.compile(r'\$\$[A-Za-z_{]')

failures = []
scanned = 0
skipped_files = 0

for dirpath, _dirnames, filenames in os.walk(k8s_dir):
    for fn in filenames:
        if not fn.endswith(('.yaml', '.yml')):
            continue
        path = os.path.join(dirpath, fn)
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        scanned += 1
        if not SKIP_MARKER.search(src):
            continue
        skipped_files += 1
        rel = os.path.relpath(path, root)
        for m in SUBST.finditer(src):
            span = m.group(0)
            if DOLLAR_DOLLAR.search(span):
                line = src[:m.start()].count('\n') + 1
                one_line = ' '.join(span.split())
                failures.append(f"  {rel}:{line}\n      {one_line[:110]}")

if not skipped_files:
    print("FAIL: found no Flux-skipped manifests at all — the guard would pass", file=sys.stderr)
    print("      trivially. Has the reconcile:disabled annotation been renamed?", file=sys.stderr)
    sys.exit(1)

if failures:
    print(f"FAIL: {len(failures)} command substitution(s) use $$VAR in a manifest Flux never renders:\n", file=sys.stderr)
    for f in failures:
        print(f, file=sys.stderr)
    print("""
The kubelet leaves `$( … )` spans verbatim, so `$$` reaches the shell and
expands to its PID. Bind the value outside the substitution instead:

    f="$$name"; SHA=$(sha256sum "$f" | cut -d ' ' -f 1)

This is how every off-site etcd snapshot came to carry an empty checksum.
""", file=sys.stderr)
    sys.exit(1)

print(f"OK: {scanned} manifests scanned, {skipped_files} of them Flux-skipped — "
      "no $$VAR inside a command substitution.")
PY
