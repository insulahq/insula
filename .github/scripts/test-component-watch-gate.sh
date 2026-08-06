#!/usr/bin/env bash
# test-component-watch-gate.sh — unit tests for the OSV → CVE-ledger gate.
#
# The gate decides whether a dependency finding blocks a merge, so its rules are
# security policy expressed as code. Two of them are easy to break by accident and
# fail SILENTLY (green CI, unblocked merge), which is why they are pinned here:
#
#   * a MAL- finding blocks even with NO severity — the natural reading of the
#     original code put unknown-severity findings in the warnings bucket, so a
#     malicious package printed a ⚠ and exited 0 (fixed 2026-08-06);
#   * `open`/`investigating`/`mitigated`/`accepted` suppress a CVE but must NOT
#     suppress a malicious package.
#
# Exit: 0 all pass · 1 any failure
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/component-watch-gate.py"
TMP="$(mktemp -d)"
# tmpfs leftovers pin node RAM — clean up on every exit path.
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

# osv_json <primary-id> <aliases-json-array> <severity> <pkg> — one finding.
osv_json() {
  cat <<JSON
{"results":[{"source":{"path":"package-lock.json"},"packages":[
  {"package":{"name":"$4","version":"1.2.3","ecosystem":"npm"},
   "groups":[{"ids":["$1"],"aliases":$2,"max_severity":"$3"}]}]}]}
JSON
}

# ledger_yaml <id> <status> — a one-entry ledger (empty args → no entries).
ledger_yaml() {
  if [[ -z "${1:-}" ]]; then
    printf 'schema_version: 1\nentries: []\n'
  else
    printf 'schema_version: 1\nentries:\n  - id: %s\n    component: backend-platform-api\n    severity: high\n    status: %s\n' "$1" "$2"
  fi
}

# check <name> <expected-rc> <osv-file> <ledger-file>
check() {
  local name="$1" want="$2" osv="$3" ledger="$4" out rc
  out="$(python3 "$GATE" "$osv" "$ledger" 2>&1)"; rc=$?
  if [[ "$rc" == "$want" ]]; then
    echo "  ✅ $name (rc=$rc)"
    pass=$((pass + 1))
  else
    echo "  ❌ $name — expected rc=$want, got rc=$rc" >&2
    printf '%s\n' "$out" | sed 's/^/       /' >&2
    fail=$((fail + 1))
  fi
}

echo "── malicious packages (MAL-) ─────────────────────────────────────────"

# THE regression this file exists for: no severity, no ledger entry → must block.
osv_json "MAL-2026-0001" '[]' "" "evil-pkg" > "$TMP/mal-nosev.json"
ledger_yaml > "$TMP/empty.yaml"
check "MAL- with NO severity blocks" 1 "$TMP/mal-nosev.json" "$TMP/empty.yaml"

# The MAL- id commonly rides along as an alias of a GHSA primary id.
osv_json "GHSA-aaaa-bbbb-cccc" '["MAL-2026-0002"]' "" "evil-pkg" > "$TMP/mal-alias.json"
check "MAL- as an ALIAS blocks" 1 "$TMP/mal-alias.json" "$TMP/empty.yaml"

# "We know, we'll get to it" is not an answer for a package stealing tokens.
for st in open investigating mitigated accepted; do
  ledger_yaml "MAL-2026-0001" "$st" > "$TMP/led-$st.yaml"
  check "MAL- is NOT cleared by status=$st" 1 "$TMP/mal-nosev.json" "$TMP/led-$st.yaml"
done

# The two escape hatches: confirmed false positive, or actually removed.
for st in not_affected fixed; do
  ledger_yaml "MAL-2026-0001" "$st" > "$TMP/led-$st.yaml"
  check "MAL- IS cleared by status=$st" 0 "$TMP/mal-nosev.json" "$TMP/led-$st.yaml"
done

# Clearing by the alias id must work too, else the ledger entry an operator
# copies out of the report (the MAL- id) would not match.
ledger_yaml "MAL-2026-0002" "not_affected" > "$TMP/led-alias.yaml"
check "MAL- alias cleared by its MAL- ledger id" 0 "$TMP/mal-alias.json" "$TMP/led-alias.yaml"

echo "── vulnerabilities (unchanged behaviour) ─────────────────────────────"

osv_json "GHSA-high-0001" '[]' "8.1" "some-lib" > "$TMP/high.json"
check "untracked HIGH blocks" 1 "$TMP/high.json" "$TMP/empty.yaml"

ledger_yaml "GHSA-high-0001" "open" > "$TMP/led-open.yaml"
check "HIGH tracked as open passes" 0 "$TMP/high.json" "$TMP/led-open.yaml"

osv_json "GHSA-med-0001" '[]' "5.3" "some-lib" > "$TMP/med.json"
check "untracked MEDIUM passes" 0 "$TMP/med.json" "$TMP/empty.yaml"

osv_json "GHSA-unk-0001" '[]' "" "some-lib" > "$TMP/unk.json"
check "untracked unknown-severity CVE warns but passes" 0 "$TMP/unk.json" "$TMP/empty.yaml"

echo "── degenerate inputs ─────────────────────────────────────────────────"

echo '{"results":[]}' > "$TMP/none.json"
check "no findings passes" 0 "$TMP/none.json" "$TMP/empty.yaml"

: > "$TMP/truncated.json"
check "empty osv.json passes (scan produced nothing)" 0 "$TMP/truncated.json" "$TMP/empty.yaml"

# A missing/broken ledger must NOT read as "everything is waived".
check "unreadable ledger errors out (rc=2)" 2 "$TMP/high.json" "$TMP/does-not-exist.yaml"

echo
if (( fail > 0 )); then
  echo "❌ test-component-watch-gate: $fail failed, $pass passed" >&2
  exit 1
fi
echo "✅ test-component-watch-gate: all $pass checks passed"
