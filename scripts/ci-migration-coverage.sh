#!/usr/bin/env bash
# ci-migration-coverage.sh — forcing function (Tier 1) for the
# "fresh-render vs existing-node" delta.
#
# WHY: bootstrap.sh renders the host firewall (nft sets + drop/accept rules)
# ONCE at install time. A change to that shape reaches FRESH installs but NOT
# already-bootstrapped nodes — those need a one-shot W10c host-migration to
# backfill (the firewall-blacklist gap, 2026-06-06, that this guard prevents
# from recurring). Until firewall rules are continuously converged (Tier 2),
# this guard makes "change the firewall → ship a migration" a hard gate.
#
# HOW: fingerprint the firewall shape from bootstrap.sh and compare to the
# committed baseline scripts/.firewall-shape.sha256. On a mismatch the PR MUST
# either (a) add a host-migration AND refresh the baseline, or (b) carry a
# `[no-host-migration]` waiver with a reason — the token at the START of a
# commit-message line (a mid-sentence prose mention does not count). Else the
# build fails.
#
# The baseline covers THREE shapes (the filename predates the latter two and is
# kept only to avoid churning AGENTS.md / the workflow / cut-release.sh):
#   1. firewall_shape        — nft sets + input-chain rules from bootstrap.sh
#   2. infra_pin_shape       — bootstrap-pinned component versions
#   3. install_time_unit_shape — the systemd units/timers bootstrap emits (2026-08-20)
#   4. helm_values_shape       — the --set flags and values-file heredocs of
#                                bootstrap's helm installs (2026-08-20)
#
# (3) was added after the converge-on-self-upgrade trigger (v2026.8.7) nearly
# shipped as fresh-install-only: bootstrap writes each unit ONCE, so editing one
# has exactly the same reach as a pin bump — yet this guard reported "unchanged
# — OK" because it never looked at unit CONTENT. Caught by hand, not by CI.
#
# Modes:
#   ci-migration-coverage.sh                  → check (CI)
#   ci-migration-coverage.sh --update-baseline → rewrite the baseline to current
#   ci-migration-coverage.sh --print           → print the current shape (debug)
#
# Testable: FWSHAPE_BOOTSTRAP / FWSHAPE_BASELINE override the inputs, and
# MIGRATION_ADDED / WAIVER / BASELINE_UPDATED override the git-derived signals.
set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BOOTSTRAP="${FWSHAPE_BOOTSTRAP:-$REPO_ROOT/scripts/bootstrap.sh}"
BASELINE="${FWSHAPE_BASELINE:-$REPO_ROOT/scripts/.firewall-shape.sha256}"
# Anchored to THIS script's directory, not REPO_ROOT: REPO_ROOT is the
# git-signal seam (tests point it at a throwaway repo to drive MIGRATION_ADDED /
# WAIVER), so deriving the lib path from it made the unit shape vanish in those
# tests — which then "passed" only because the vacuity check hard-failed them
# for an unrelated reason. Source location and git location are different seams.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${FWSHAPE_LIB_DIR:-$SCRIPT_DIR/lib}"
BASE_REF="${BASE_REF:-origin/main}"

# Units that MUST appear in the unit shape. This is the anti-vacuity canary: if
# the extraction silently stops matching (a refactor moves the heredocs, someone
# switches to `install -m` or a printf, awk changes behaviour), the fingerprint
# would quietly shrink to nothing and every future unit edit would pass. An
# empty or incomplete set is a HARD FAIL, never a pass — the same lesson as
# "0 violations is also true of an empty table".
REQUIRED_UNITS="${FWSHAPE_REQUIRED_UNITS:-platform-ops-update.service platform-ops-update.timer platform-ops-host-config.service platform-ops-host-config.timer}"

# Helm releases that MUST appear in the values shape — same anti-vacuity role as
# REQUIRED_UNITS. If the extraction stops matching (someone reformats the helm
# block, switches to a values file under a name that is not *VALUES, or the awk
# breaks), the fingerprint would quietly shrink and every future --set change
# would pass. Empty or incomplete is a HARD FAIL.
REQUIRED_HELM_RELEASES="${FWSHAPE_REQUIRED_HELM_RELEASES:-traefik cert-manager longhorn cnpg}"

# Structural firewall lines: nft set declarations + the input-chain
# drop/accept rules + chain policies. Comments are stripped FIRST (so a
# comment that merely mentions a port can't churn the hash), then whitespace
# normalised (so reindentation isn't a "change").
#
# Notes:
#   - drop set names end in a digit (@blacklist_v4) → the set-ref class must
#     allow [a-z0-9_]+, not [a-z_]+ (which stops at the digit and matches
#     NOTHING — a dead pattern bug, code-review 2026-06-06).
#   - set declarations have NO `^[[:space:]]*` anchor: some live inside a
#     `local set_decls="  set tenant_ports_tcp {` assignment, so anchoring to
#     line-start would miss them.
firewall_shape() {
  sed -E 's/#.*$//' "$BOOTSTRAP" \
    | grep -E 'set (blacklist|crowdsec_blocklist|trusted_ranges|cluster_peers|tenant_ports)[a-z0-9_]* \{|saddr @[a-z0-9_]+ drop|dport [0-9]+ (accept|drop)|policy (drop|accept)|type filter hook' \
    | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -v '^$'
}

# Bootstrap-pinned infra component versions (k3s, Calico, Longhorn, Traefik,
# cert-manager, sealed-secrets, CNPG, Flux, external-snapshotter). bootstrap.sh
# installs/pins these ONCE at install time, so a version bump reaches FRESH
# installs but NOT already-bootstrapped clusters — those need a one-shot W10c
# host-migration to upgrade in place (same forcing-function rationale as the
# firewall shape above; the external-snapshotter v6→v8 gap, 2026-06-30, that
# adding this here prevents from recurring). Match only literal version
# assignments (`="v?<digit>…`) so arg-parser lines like `K3S_VERSION="$2"` never
# churn the hash; trailing `# date` comments are already stripped above, so a
# comment edit is not a change.
infra_pin_shape() {
  sed -E 's/#.*$//' "$BOOTSTRAP" \
    | grep -E '(K3S_VERSION|CALICO_VERSION|LONGHORN_VERSION|TRAEFIK_CHART_VERSION|CERT_MANAGER_CHART_VERSION|SEALED_SECRETS_CHART_VERSION|CNPG_CHART_VERSION|FLUX_VERSION|snap_ver)="v?[0-9]' \
    | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -v '^$'
}

# Systemd units + timers emitted by an install-time heredoc. bootstrap writes
# each ONCE; nothing reconverges them, so editing one reaches FRESH installs
# only — identical reach to a pin bump, and the reason this function exists.
#
# SCOPE — deliberately units/timers, not every heredoc bootstrap writes:
#   included  *.service / *.timer          nothing converges these  ← the gap
#   excluded  /etc/sysctl.d, limits.d,     `platform-ops host-config` DOES
#             modules-load.d               reconverge these every hour
#   excluded  /etc/nftables.conf           already covered by firewall_shape()
#   excluded  /etc/platform/*credentials   per-install secrets, not a shape
# Widening the set is a one-line change to UNIT_DEST_RE — but check first that
# the new class isn't already converged, or this becomes waiver-fatigue.
#
# Comments and blank lines are stripped (same rationale as firewall_shape: a
# comment edit must not churn the hash) and whitespace is normalised, so
# reindenting a unit is not a "change". The destination is part of the
# fingerprint, so MOVING a unit counts as a change too.
UNIT_DEST_RE='\.(service|timer)$'
install_time_unit_shape() {
  local f
  for f in "$BOOTSTRAP" "$LIB_DIR"/*.sh; do
    [ -f "$f" ] || continue
    awk -v dest_re="$UNIT_DEST_RE" '
      # Heredoc opener writing to a file: cat > DEST <<[-][quote]DELIM[quote]
      !in_body && match($0, /cat[[:space:]]*>>?[[:space:]]*[^<]*<<-?[[:space:]]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/) {
        line = $0
        # DEST = text between the redirect and the heredoc operator.
        dest = line; sub(/^.*cat[[:space:]]*>>?[[:space:]]*/, "", dest); sub(/[[:space:]]*<<.*$/, "", dest)
        gsub(/["'"'"']/, "", dest)
        # DELIM = the word after <<, minus an optional - and quotes.
        delim = line; sub(/^.*<<-?[[:space:]]*/, "", delim); gsub(/["'"'"']/, "", delim)
        sub(/[^A-Za-z0-9_].*$/, "", delim)
        if (dest ~ dest_re) { in_body = 1; cur_dest = dest; cur_delim = delim }
        next
      }
      in_body {
        t = $0
        # Leading indentation is dropped here so the tab-stripping heredoc form
        # compares equal. (Do NOT write that operator literally in a comment:
        # ci-heredoc-expansion-check.sh reads it as opening a heredoc named by
        # the next word, and then reports every later backtick as unquoted.)
        sub(/^[[:space:]]+/, "", t)
        if (t == cur_delim) { in_body = 0; next }       # end of this heredoc
        sub(/#.*$/, "", t)                              # strip comments
        gsub(/[[:space:]]+/, " ", t)
        sub(/^ +/, "", t); sub(/ +$/, "", t)
        if (t != "") print cur_dest "|" t
      }
    ' "$f"
  done
}

# Helm values passed by bootstrap's `helm upgrade --install` calls.
#
# bootstrap installs Traefik, cert-manager, sealed-secrets, Longhorn and CNPG
# ONCE. A `--set` change therefore has exactly the reach of a pin bump — FRESH
# INSTALLS ONLY — but until 2026-08-20 nothing fingerprinted it, so the guard
# reported "unchanged — OK" for a change existing clusters would never receive.
# Found while adding the Traefik plugin-wait initContainer (v2026.8.8), whose
# host-migration had to be written by hand for exactly this reason.
#
# TWO sources are hashed, because a values FILE hides its content from a flag
# scan:
#   1. --set / --set-string / --set-file / -f flags inside a helm block
#   2. the body of any heredoc whose delimiter ends in VALUES
#
# CONTRACT: a helm values heredoc MUST be named <SOMETHING>VALUES to be
# covered. That is asserted below, so a values file smuggled in under another
# name fails the guard rather than slipping past it.
helm_values_shape() {
  sed -E 's/#.*$//' "$BOOTSTRAP" \
    | awk '
        # Enter a helm block; stay in it while lines continue with a backslash.
        # The invocation line itself is part of the shape: the release name,
        # chart and --version are as fresh-install-only as any --set.
        /helm_cmd[[:space:]]+(upgrade|install)/ { inblk = 1; print "helm|" $0; next }
        inblk {
          line = $0
          if (line ~ /(--set(-string|-file)?|--version|[[:space:]]-f)[[:space:]]/) print "helm|" line
          if (line !~ /\\[[:space:]]*$/) inblk = 0
        }
      ' \
    | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -v '^$'

  # Values-file heredoc bodies. Comments are NOT stripped inside these: the
  # body is a YAML document that ships verbatim into the chart, so a '#' may
  # be data. Blank lines are dropped so reformatting is not a change.
  awk '
      /<<[[:space:]]*.?[A-Za-z_][A-Za-z0-9_]*VALUES.?[[:space:]]*$/ && !inbody {
        d = $0; sub(/^.*<<[[:space:]]*/, "", d); gsub(/["\x27]/, "", d)
        inbody = 1; delim = d; next
      }
      inbody {
        t = $0; sub(/^[[:space:]]+/, "", t)
        if (t == delim) { inbody = 0; next }
        gsub(/[[:space:]]+/, " ", $0)
        if ($0 != "") print "helmvalues|" delim "|" $0
      }
    ' "$BOOTSTRAP"
}

# The coverage hash spans the firewall shape, the infra version pins AND the
# install-time systemd units — a change to any of the three is a "fresh-render
# vs existing-node" delta that an existing cluster only gets via a migration.
render_shape() { firewall_shape; infra_pin_shape; install_time_unit_shape; helm_values_shape; }
current_hash() { render_shape | sha256sum | awk '{print $1}'; }

# Fail closed if the unit extraction found nothing (or lost a known unit) — see
# REQUIRED_UNITS. Runs before every mode INCLUDING --update-baseline, so a
# broken parser can never be frozen into the baseline as "correct".
assert_helm_shape_non_vacuous() {
  local shape missing=""
  # Test seam: when FWSHAPE_BOOTSTRAP points at a fixture that is not a real
  # bootstrap.sh, "no helm blocks" is expected, not a broken extraction. The
  # canary still runs for the DEFAULT bootstrap (i.e. in CI, where it matters)
  # and for any fixture whose test opts in by setting the release list.
  if [ -n "${FWSHAPE_BOOTSTRAP:-}" ] && [ -z "${FWSHAPE_REQUIRED_HELM_RELEASES:-}" ]; then
    return 0
  fi
  shape="$(helm_values_shape)"
  if [ -z "$shape" ]; then
    echo "::error::ci-migration-coverage: helm values shape is EMPTY — the helm-block extraction matched nothing." >&2
    echo "  This guard would silently pass every future --set / values-file change. Fix helm_values_shape()." >&2
    return 1
  fi
  local r
  for r in $REQUIRED_HELM_RELEASES; do
    printf '%s\n' "$shape" | grep -qF -- "$r" || missing="$missing $r"
  done
  if [ -n "$missing" ]; then
    echo "::error::ci-migration-coverage: expected helm release(s) absent from the fingerprint:$missing" >&2
    echo "  Either the release was removed (update FWSHAPE_REQUIRED_HELM_RELEASES), or the" >&2
    echo "  extraction broke. NOTE: a values file is only covered when its heredoc delimiter" >&2
    echo "  ends in VALUES — rename it, do not weaken the guard." >&2
    return 1
  fi
  return 0
}

assert_unit_shape_non_vacuous() {
  local shape missing=""
  shape="$(install_time_unit_shape)"
  if [ -z "$shape" ]; then
    echo "::error::ci-migration-coverage: install-time unit shape is EMPTY — the heredoc extraction matched nothing." >&2
    echo "  This guard would silently pass every future systemd-unit change. Fix the extraction in install_time_unit_shape()." >&2
    return 1
  fi
  local u
  for u in $REQUIRED_UNITS; do
    printf '%s\n' "$shape" | grep -qF -- "$u" || missing="$missing $u"
  done
  if [ -n "$missing" ]; then
    echo "::error::ci-migration-coverage: expected unit(s) absent from the fingerprint:$missing" >&2
    echo "  Either the unit was legitimately removed/renamed (update FWSHAPE_REQUIRED_UNITS)," >&2
    echo "  or the extraction broke and the guard is no longer covering it." >&2
    return 1
  fi
  return 0
}

# Render the same three shapes from BASE_REF's copies of the sources, so a
# failure can name the lines that actually changed. Best-effort: any git failure
# (shallow clone, renamed file, no such ref) yields empty and the caller skips
# the hint. BOOTSTRAP/LIB_DIR are read at call time, so a subshell override is
# enough — no duplication of the shape logic.
shape_at_base() {
  local tmp
  tmp="$(mktemp -d)" || return 1
  # shellcheck disable=SC2064  # expand tmp now, not at trap time
  trap "rm -rf '$tmp'" RETURN
  git -C "$REPO_ROOT" show "$BASE_REF:scripts/bootstrap.sh" > "$tmp/bootstrap.sh" 2>/dev/null || return 1
  mkdir -p "$tmp/lib"
  local f rel got=0
  for f in "$LIB_DIR"/*.sh; do
    [ -f "$f" ] || continue
    rel="$(basename "$f")"
    if git -C "$REPO_ROOT" show "$BASE_REF:scripts/lib/$rel" > "$tmp/lib/$rel" 2>/dev/null; then
      got=1
    else
      rm -f "$tmp/lib/$rel"   # new file on this branch — absent at base, correctly
    fi
  done
  [ "$got" -eq 1 ] || return 1
  ( BOOTSTRAP="$tmp/bootstrap.sh"; LIB_DIR="$tmp/lib"; render_shape )
}

assert_unit_shape_non_vacuous || exit 1
assert_helm_shape_non_vacuous || exit 1

case "${1:-}" in
  --print) render_shape; exit 0 ;;
  --update-baseline)
    current_hash > "$BASELINE"
    echo "ci-migration-coverage: baseline refreshed → $BASELINE ($(cat "$BASELINE"))"
    exit 0 ;;
esac

cur="$(current_hash)"
base="$(cat "$BASELINE" 2>/dev/null || echo "")"

if [[ "$cur" == "$base" ]]; then
  echo "ci-migration-coverage: firewall shape + infra pins + install-time units + helm values unchanged — OK."
  exit 0
fi

# Validate the test-override env seams BEFORE any arithmetic: a non-integer
# value like `a[$(cmd)]` would execute inside `$(( ))` (bash evaluates array
# subscripts). Empty = unset → the git-derived fallback below is used.
for _v in MIGRATION_ADDED WAIVER BASELINE_UPDATED; do
  case "${!_v-}" in
    '') ;;
    *[!0-9]*) echo "ci-migration-coverage: $_v must be a non-negative integer" >&2; exit 2 ;;
  esac
done

# Shape changed → require coverage. Signals are git-derived in CI, overridable
# in tests.
migration_added="${MIGRATION_ADDED:-$(git -C "$REPO_ROOT" diff --diff-filter=A --name-only "$BASE_REF"...HEAD -- 'platform/host-migrations/' 2>/dev/null | grep -E '/[0-9]+-[a-z0-9-]+\.sh$' | grep -vc '\.test\.sh$')}"
# Line-anchored: the waiver token must START a commit-message line (optionally
# indented), so a prose/markdown mention mid-sentence (e.g. "... a
# `[no-host-migration]` waiver") does NOT count as a waiver.
waiver="${WAIVER:-$(git -C "$REPO_ROOT" log "$BASE_REF"..HEAD --format=%B 2>/dev/null | grep -cE '^[[:space:]]*\[no-host-migration\]')}"
baseline_updated="${BASELINE_UPDATED:-$(git -C "$REPO_ROOT" diff --name-only "$BASE_REF"...HEAD -- "$BASELINE" 2>/dev/null | grep -c .)}"
# Coerce to integers (now guaranteed numeric-or-empty; empty → 0).
migration_added=$(( migration_added + 0 )) 2>/dev/null || migration_added=0
waiver=$(( waiver + 0 )) 2>/dev/null || waiver=0
baseline_updated=$(( baseline_updated + 0 )) 2>/dev/null || baseline_updated=0

if (( waiver > 0 )); then
  echo "ci-migration-coverage: install-time host shape changed; [no-host-migration] waiver present — allowed."
  # A waiver still must refresh the baseline so the NEXT PR starts clean.
  if (( baseline_updated == 0 )); then
    echo "::error::waiver requires refreshing the baseline: run scripts/ci-migration-coverage.sh --update-baseline and commit scripts/.firewall-shape.sha256" >&2
    exit 1
  fi
  exit 0
fi

if (( migration_added > 0 && baseline_updated > 0 )); then
  echo "ci-migration-coverage: install-time host shape changed + host-migration added + baseline refreshed — OK."
  exit 0
fi

echo "::error::ci-migration-coverage: an install-time host shape changed but no host-migration upgrades existing nodes." >&2
echo "  Covered: firewall rules, infra version pins, and the systemd units bootstrap emits." >&2
echo "  Existing clusters render all three ONCE at bootstrap — a change here will NOT reach them." >&2
# Name the ACTUAL changed lines. A guard that says "firewall or pin" when the
# real edit was a systemd unit sends the reader to the wrong file — best-effort
# only (a missing/renamed base file just skips the hint, never fails the run).
if _base_shape="$(shape_at_base 2>/dev/null)" && [ -n "$_base_shape" ]; then
  _delta="$(diff <(printf '%s\n' "$_base_shape") <(render_shape) 2>/dev/null | grep -E '^[<>]' | head -12)"
  if [ -n "$_delta" ]; then
    echo "  What changed (< ${BASE_REF}, > HEAD):" >&2
    printf '%s\n' "$_delta" | sed 's/^/    /' >&2
  fi
fi
echo "  Do ONE of:" >&2
echo "   1. Add platform/host-migrations/<next-version>/NNNN-name.sh that idempotently backfills the change," >&2
echo "      then refresh the baseline:  ./scripts/ci-migration-coverage.sh --update-baseline" >&2
echo "      and commit scripts/.firewall-shape.sha256." >&2
echo "   2. If existing nodes genuinely don't need it, start a commit-message line with" >&2
echo "      '[no-host-migration]' (followed by a reason) AND refresh the baseline as above." >&2
(( migration_added == 0 )) && echo "  (detected: no new host-migration in the diff)" >&2
(( baseline_updated == 0 )) && echo "  (detected: scripts/.firewall-shape.sha256 not refreshed in the diff)" >&2
exit 1
