#!/usr/bin/env bash
# ci-no-dead-components.sh — a panel component that nothing imports is dead
# code, and dead code in a UI is invisible: it typechecks, it passes its own
# tests, and the bundler drops it silently.
#
# WHY THIS EXISTS
# ---------------
# SystemStorageCard — the only way to grow the platform database's volume from
# the panel — was mounted on the old SystemBackupPage's `storage` tab and was
# deleted, import and mount together, when that page was consolidated into
# SystemBackupsPage. Nothing failed. The card kept compiling, its backend routes
# (`GET/POST /admin/system/pvc/storage`) kept answering, and the operator simply
# had no route to them for four months. It was found by accident, while checking
# that a CHANGELOG line naming the screen was true.
#
# A unit test cannot catch this: the regression is the ABSENCE of a reference,
# and there is nothing left to assert on. Reachability is the only thing that
# distinguishes a live component from a dead one.
#
# THE RULE
# --------
# Every *.tsx under frontend/*/src/components/ must be named by at least one
# other source file in the same panel. Test files are entry points, so they are
# subjects of the rule, not references for it — a component whose only mention
# is its own test is still unreachable from the product.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Known-dead, awaiting triage. Each needs a decision — mount it or delete it —
# and neither is a release-blocking change. Listing them keeps the guard green
# for everything else instead of leaving it off entirely; REMOVE an entry when
# the component is wired or deleted, never to quiet a new failure.
ALLOWLIST=(
  "frontend/admin-panel/src/components/MailSslStatusModal.tsx"
  "frontend/admin-panel/src/components/ResizeStorageModal.tsx"
  "frontend/admin-panel/src/components/system-backup/LonghornSnapshotsTab.tsx"
)

echo "── dead-component guard ───────────────────────────────────────────"
python3 - "${ALLOWLIST[@]}" <<'PY'
import glob, os, re, sys

allow = set(sys.argv[1:])
dead, checked = [], 0

for panel in sorted(glob.glob('frontend/*/src')):
    comps = [p for p in glob.glob(os.path.join(panel, 'components', '**', '*.tsx'), recursive=True)
             if not p.endswith('.test.tsx')]
    srcs = (glob.glob(os.path.join(panel, '**', '*.ts'), recursive=True)
            + glob.glob(os.path.join(panel, '**', '*.tsx'), recursive=True))
    # Read once: this runs over ~450 files per panel.
    blob = {p: open(p, encoding='utf-8', errors='replace').read() for p in srcs}
    for c in comps:
        checked += 1
        name = os.path.splitext(os.path.basename(c))[0]
        # Word-boundary match on the FILE stem, which is the component name by
        # convention here. A substring match would let `Foo` be satisfied by
        # `FooBar` and hide exactly the case this guard is for.
        pat = re.compile(r'\b' + re.escape(name) + r'\b')
        if any(pat.search(t) for p, t in blob.items() if p != c):
            continue
        if c in allow:
            print(f"  allowlisted (awaiting triage): {c}")
            continue
        dead.append(c)

if dead:
    print()
    print("ci-no-dead-components: component(s) no other file references:")
    for d in dead:
        print(f"  - {d}")
    print()
    print("A component nothing imports is not shipped — the bundler drops it and")
    print("no test fails. Either mount it on the page it belongs to, or delete it")
    print("along with any hooks and routes that exist only to serve it.")
    raise SystemExit(1)

print(f"ci-no-dead-components: OK — {checked} component(s) checked, all reachable.")
PY
