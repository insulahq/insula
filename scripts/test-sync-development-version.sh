#!/usr/bin/env bash
# test-sync-development-version.sh — unit tests for the post-release
# platform/VERSION sync.
#
# The invariant under test is the one that silently broke for six weeks:
# development's platform/VERSION must name a tag that was actually cut, because
# a fresh install resolves its platform-ops asset from it. Getting this wrong is
# invisible — the install skips, no timer is written, and nothing reports a timer
# that never existed.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/sync-development-version.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
yes() { if eval "$2"; then ok "$1"; else bad "$1 — predicate failed: $2"; fi; }

mkroot() { # mkroot <current-version> -> echoes a temp repo root
  local d; d=$(mktemp -d); mkdir -p "$d/platform"; printf '%s\n' "$1" > "$d/platform/VERSION"; echo "$d"
}
ver() { tr -d '[:space:]' < "$1/platform/VERSION"; }

echo "sync-development-version"

# ── The live failure: development stuck on a version never released ──────────
R=$(mkroot 2026.6.16)
"$SCRIPT" --tag v2026.8.2 --root "$R" --write >/dev/null 2>&1; rc=$?
yes "stale development VERSION is advanced to the cut tag" "[ '$(ver "$R")' = '2026.8.2' ]"
yes "  … and reports a change (exit 0)" "[ $rc -eq 0 ]"
rm -rf "$R"

# ── Prereleases must NOT be written, and this is load-bearing, not taste.
#    build-deploy stamps the dev overlay as `<VERSION>-<short-sha>`, and the
#    backend's VERSION_RE allows at most ONE hyphenated suffix. An RC composes to
#    `2026.8.3-rc.4-dd36418`, which that regex rejects — persistInstalledVersion()
#    would silently stop writing `installed_platform_version` and the upgrade
#    spine would lose what pre-flight gates on.
R=$(mkroot 2026.8.2)
"$SCRIPT" --tag v2026.8.3-rc.1 --root "$R" --write >/dev/null 2>&1; rc=$?
yes "a prerelease is NOT written (the <VERSION>-<sha> composite would stop parsing)" "[ '$(ver "$R")' = '2026.8.2' ]"
yes "  … and it is a no-op, not a workflow failure (exit 2)" "[ $rc -eq 2 ]"

# Prove the constraint rather than asserting it from memory: whatever this script
# is willing to write must still parse as a platform version once build-deploy
# appends the short sha.
for cand in 2026.8.2 2026.8.3-rc.1; do
  printf '%s\n' 2026.0.1 > "$R/platform/VERSION"
  "$SCRIPT" --tag "v$cand" --root "$R" --write >/dev/null 2>&1
  written=$(ver "$R")
  [ "$written" = "$cand" ] || continue        # refused → nothing to check
  node -e 'const RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.]+)?$/;
           process.exit(RE.test(process.argv[1] + "-dd36418") ? 0 : 1)' "$written"
  yes "written value '$written' still parses with the -<sha> suffix build-deploy adds" "[ $? -eq 0 ]"
done
rm -rf "$R"

# ── Idempotence: the workflow re-runs, and must not churn commits ────────────
R=$(mkroot 2026.8.3-rc.4)
"$SCRIPT" --tag v2026.8.3-rc.4 --root "$R" --write >/dev/null 2>&1; rc=$?
yes "already in sync → exit 2 (no commit)" "[ $rc -eq 2 ]"
rm -rf "$R"

# ── Never move backwards. A re-run for an older tag, or a late job from a
#    superseded RC, must not drag development onto an older binary.
R=$(mkroot 2026.8.3)
"$SCRIPT" --tag v2026.8.2 --root "$R" --write >/dev/null 2>&1; rc=$?
yes "older stable tag → refuses to move VERSION backwards" "[ '$(ver "$R")' = '2026.8.3' ]"
yes "  … and says so without failing the workflow (exit 2)" "[ $rc -eq 2 ]"
rm -rf "$R"

# THE ORDERING TRAP: semver says 2026.8.3-rc.4 < 2026.8.3, but plain `sort -V`
# puts the LONGER string last and would call the rc newer. If that regressed,
# a stable release would be silently rejected as "backwards".
R=$(mkroot 2026.8.3-rc.4)
"$SCRIPT" --tag v2026.8.3 --root "$R" --write >/dev/null 2>&1
yes "stable SUPERSEDES its own rc (2026.8.3 > 2026.8.3-rc.4)" "[ '$(ver "$R")' = '2026.8.3' ]"
rm -rf "$R"

R=$(mkroot 2026.8.3)
"$SCRIPT" --tag v2026.8.3-rc.5 --root "$R" --write >/dev/null 2>&1
yes "an rc does NOT supersede the stable of the same version" "[ '$(ver "$R")' = '2026.8.3' ]"
rm -rf "$R"

R=$(mkroot 2026.8.9)
"$SCRIPT" --tag v2026.8.10 --root "$R" --write >/dev/null 2>&1
yes "double-digit patch beats single (2026.8.10 > 2026.8.9, not lexical)" "[ '$(ver "$R")' = '2026.8.10' ]"
rm -rf "$R"

# ── Only ever write something bootstrap can resolve ──────────────────────────
R=$(mkroot 2026.8.2)
"$SCRIPT" --tag v2026.8.3-beta --root "$R" --write >/dev/null 2>&1; rc=$?
yes "a non-platform tag is rejected, not written" "[ '$(ver "$R")' = '2026.8.2' ] && [ $rc -eq 1 ]"
rm -rf "$R"

# The accepted shape must stay IDENTICAL to platform_ops_target_version() in
# bootstrap-phases.sh. A value this writes but that bootstrap then rejects as
# unresolvable would recreate the original outage in a new way.
PHASES="$(cd "$(dirname "$0")" && pwd)/lib/bootstrap-phases.sh"
RE='^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$'
yes "accepted version shape is identical to bootstrap's platform_ops_target_version" \
  "grep -qF \"\$RE\" '$PHASES' && grep -qF \"\$RE\" '$SCRIPT'"

# ── Dry run must not touch the file ──────────────────────────────────────────
R=$(mkroot 2026.6.16)
"$SCRIPT" --tag v2026.8.3 --root "$R" >/dev/null 2>&1
yes "without --write the file is untouched" "[ '$(ver "$R")' = '2026.6.16' ]"
rm -rf "$R"

echo
echo "sync-development-version tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
