#!/usr/bin/env bash
# ci-host-migrations-check.sh — guard the host-migration runner (ADR-045 W10c).
#
# Host-migrations are per-release one-shot bash scripts run as ROOT on every node
# by `platform-ops host-config`. They ship EMBEDDED in the binary (so they travel
# with every self-upgrade) and are opt-in gated (host-migrations-desired mode).
# Because they run as root, the authoring discipline is enforced here.
#
# Invariants:
#   1. The runner re-validates every script's version + name before running it
#      (host-migrations.ts), and the marker path is containment-checked (index.ts).
#   2. The build embeds the catalog as SEA assets + a manifest (build-platform-ops.sh).
#   3. Every shipped platform/host-migrations/<version>/<NNNN-name.sh>:
#      - lives under a CalVer version dir; name matches ^[0-9]{3,}-[a-z0-9-]+\.sh$
#      - starts with `#!/usr/bin/env bash` + `set -euo pipefail`
#      - carries `# idempotent:` and `# allow-paths:` header contracts
#      - from release PHASE_REQUIRED_FROM on, declares `# phase: before-services`
#        or `# phase: after-services` (ADR-064 §3); a present value must be valid
#      - passes shellcheck (when shellcheck is available)
#   A catalog with ZERO scripts is valid (the runner is dormant by default).

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUNNER_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/host-migrations.ts"
INDEX_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/index.ts"
BUILD_SH="$REPO_ROOT/scripts/build-platform-ops.sh"
HM_ROOT="$REPO_ROOT/platform/host-migrations"
NAME_RE='^[0-9]{3,}-[a-z0-9][a-z0-9-]*\.sh$'
VER_RE='^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$'

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0

echo "ci-host-migrations-check: verifying host-migration runner + catalog..."

# (1) runner re-validates; marker path is contained
if [[ -f "$RUNNER_TS" ]]; then
  grep -q 'hostMigrationValid' "$RUNNER_TS" || fail "host-migrations.ts must validate each script (hostMigrationValid)"
  grep -q "'invalid'" "$RUNNER_TS" || fail "host-migrations.ts must mark bad scripts 'invalid' (never run them)"
  grep -q "'blocked'" "$RUNNER_TS" || fail "host-migrations.ts must HALT (mark later scripts 'blocked') on first failure"
else
  fail "host-migrations.ts is missing"
fi
if [[ -f "$INDEX_TS" ]]; then
  awk '/function migrationMarkerPath/{f=1} f&&/hostMigrationValid/{v=1} f&&/startsWith\(HOST_MIGRATION_MARKER_ROOT/{c=1} f&&/^}/{exit} END{exit !(v&&c)}' "$INDEX_TS" \
    || fail "migrationMarkerPath must re-validate (hostMigrationValid) AND containment-check the marker path"
  grep -q "execFileSync('/bin/bash'" "$INDEX_TS" || fail "migrationRunScript must exec /bin/bash by absolute path (argv-only)"
else
  fail "host-config/index.ts is missing"
fi

# (2) build embeds the catalog
[[ -f "$BUILD_SH" ]] && grep -q 'host-migrations/manifest.json' "$BUILD_SH" \
  || fail "build-platform-ops.sh must embed the host-migration catalog (host-migrations/manifest.json asset)"

# (3) every shipped script obeys the authoring contract
PHASE_REQUIRED_FROM="2026.10.7"
# ADR-064 §6: the upgrade review lists each host change by its description.
DESCRIPTION_REQUIRED_FROM="2026.10.7"
SCRIPT_COUNT=0
if [[ -d "$HM_ROOT" ]]; then
  while IFS= read -r -d '' f; do
    SCRIPT_COUNT=$((SCRIPT_COUNT + 1))
    rel="${f#"$HM_ROOT"/}"
    version="${rel%%/*}"
    name="${rel##*/}"
    [[ "$version" =~ $VER_RE ]] || fail "$rel: version dir '$version' is not CalVer"
    [[ "$name" =~ $NAME_RE ]] || fail "$rel: name must match ${NAME_RE}"
    [[ "$(sed -n '1p' "$f")" == '#!/usr/bin/env bash' ]] || fail "$rel: first line must be '#!/usr/bin/env bash'"
    grep -q 'set -euo pipefail' "$f" || fail "$rel: must 'set -euo pipefail'"
    grep -q '^# idempotent:' "$f" || fail "$rel: missing '# idempotent:' header contract"
    grep -q '^# allow-paths:' "$f" || fail "$rel: missing '# allow-paths:' header contract"
    # ADR-056 §1: the header is OPTIONAL (absent ⇒ blocks, the safe default), but
    # a typo'd value must not silently read as "blocks" when the author meant the
    # opposite — that is the whole failure mode this policy exists to prevent.
    if grep -q '^# blocks-on-failure:' "$f"; then
      v=$(grep -m1 '^# blocks-on-failure:' "$f" | sed -E 's/^# blocks-on-failure:[[:space:]]*([^[:space:]]+).*/\1/' | tr 'A-Z' 'a-z')
      case "$v" in
        yes|no) : ;;
        *) fail "$rel: '# blocks-on-failure: $v' — must be exactly 'yes' or 'no' (absent means yes)" ;;
      esac
    fi
    # ADR-064 §3: WHEN a script runs relative to the services' roll. Required from
    # PHASE_REQUIRED_FROM on (older scripts are applied or baselined everywhere and
    # read as before-services); a present value must be exact — the runner treats
    # anything else as invalid and never runs it.
    if grep -q '^# phase:' "$f"; then
      p=$(grep -m1 '^# phase:' "$f" | sed -E 's/^# phase:[[:space:]]*([^[:space:]]+).*/\1/' | tr 'A-Z' 'a-z')
      case "$p" in
        before-services|after-services) : ;;
        *) fail "$rel: '# phase: $p' — must be exactly 'before-services' or 'after-services'" ;;
      esac
    elif [[ "$(printf '%s\n%s\n' "$PHASE_REQUIRED_FROM" "$version" | sort -V | head -n1)" == "$PHASE_REQUIRED_FROM" ]]; then
      fail "$rel: missing '# phase: before-services|after-services' (required from ${PHASE_REQUIRED_FROM}, ADR-064)"
    fi
    # ADR-064 §6: one line an operator reads in the upgrade review. The release
    # manifest carries it (release.yml), so it must stay short and plain.
    if grep -q '^# description:' "$f"; then
      d=$(grep -m1 '^# description:' "$f" | sed -E 's/^# description:[[:space:]]*//')
      if (( ${#d} < 10 || ${#d} > 200 )); then
        fail "$rel: '# description:' must be 10–200 characters (got ${#d})"
      fi
    elif [[ "$(printf '%s\n%s\n' "$DESCRIPTION_REQUIRED_FROM" "$version" | sort -V | head -n1)" == "$DESCRIPTION_REQUIRED_FROM" ]]; then
      fail "$rel: missing '# description: <one line for the upgrade review>' (required from ${DESCRIPTION_REQUIRED_FROM}, ADR-064)"
    fi
    if command -v shellcheck >/dev/null 2>&1; then
      shellcheck -S warning "$f" || fail "$rel: shellcheck reported issues"
    fi
  done < <(find "$HM_ROOT" -type f -name '*.sh' -print0)
fi
if command -v shellcheck >/dev/null 2>&1; then :; else echo "  • shellcheck not installed — skipped script linting"; fi
echo "  • ${SCRIPT_COUNT} host-migration script(s) checked$([[ "$SCRIPT_COUNT" -eq 0 ]] && echo ' (runner dormant by default)')"

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-host-migrations-check: FAILED" >&2
  exit 1
fi
echo "ci-host-migrations-check: OK"
