#!/usr/bin/env bash
# ci-secrets-denylist-check.sh — DR-bundle bundle-everything redesign.
#
# The "auto-managed Secret" predicate lives in THREE places that must
# stay byte-stable:
#   1. backend/src/modules/system-backup/secrets-denylist.ts (TS, used
#      by the in-cluster exporter + audit)
#   2. scripts/lib/secrets-denylist.jq (jq, used by bootstrap.sh's
#      offline shell exporter)
#   3. k8s/base/backup/secrets-denylist-configmap.yaml (ConfigMap
#      mounted by the secrets-backup CronJob)
#
# This guard enforces that (2) and (3) carry byte-identical jq code,
# and that the canonical reason-strings constants in (1) match the
# ones the jq filter emits. Drift fails CI; fixing it means editing
# all three together.
#
# Exit codes:
#   0 — denylist is in sync across all three sources
#   1 — drift detected

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC_JQ="$ROOT/scripts/lib/secrets-denylist.jq"
CM_YAML="$ROOT/k8s/base/backup/secrets-denylist-configmap.yaml"
TS_FILE="$ROOT/backend/src/modules/system-backup/secrets-denylist.ts"

fail() {
  echo "ci-secrets-denylist-check: FAIL: $*" >&2
  exit 1
}

[[ -r "$SRC_JQ" ]]  || fail "missing $SRC_JQ"
[[ -r "$CM_YAML" ]] || fail "missing $CM_YAML"
[[ -r "$TS_FILE" ]] || fail "missing $TS_FILE"

# 1. ConfigMap's denylist.jq must equal the canonical file.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
# Extract the body under `denylist.jq: |` and strip the 4-space indent.
python3 - "$CM_YAML" > "$TMP" <<'PY'
import sys, yaml
with open(sys.argv[1]) as f:
    doc = yaml.safe_load(f)
print(doc['data']['denylist.jq'], end='')
PY
if ! diff -q "$SRC_JQ" "$TMP" >/dev/null; then
  echo "ci-secrets-denylist-check: ConfigMap denylist.jq diverges from scripts/lib/secrets-denylist.jq" >&2
  diff "$SRC_JQ" "$TMP" | head -40 >&2
  exit 1
fi

# 2. Each REASON_* const in the TS file must appear verbatim in the
#    jq filter. Reason text is the consumer-facing contract; both
#    implementations must agree.
REASONS=$(grep -E "^const REASON_[A-Z_]+ = '" "$TS_FILE" \
  | sed -E "s/^const REASON_[A-Z_]+ = '([^']+)';?/\1/")
MISSING=0
while IFS= read -r reason; do
  [[ -z "$reason" ]] && continue
  if ! grep -qF "$reason" "$SRC_JQ"; then
    echo "ci-secrets-denylist-check: jq filter missing reason '$reason'" >&2
    MISSING=$((MISSING + 1))
  fi
done <<< "$REASONS"
if (( MISSING > 0 )); then
  exit 1
fi

# 3. Sanity: every reason in the jq file must appear in TS too (catch
#    typos in the jq side that snuck past the TS).
JQ_REASONS=$(grep -oE 'reason: "[^"]+"' "$SRC_JQ" | sed 's/^reason: "//;s/"$//' | sort -u)
MISSING=0
while IFS= read -r reason; do
  [[ -z "$reason" ]] && continue
  if ! grep -qF "$reason" "$TS_FILE"; then
    echo "ci-secrets-denylist-check: TS DENYLIST_REASONS missing '$reason'" >&2
    MISSING=$((MISSING + 1))
  fi
done <<< "$JQ_REASONS"
if (( MISSING > 0 )); then
  exit 1
fi

echo "✓ secrets-denylist parity: jq file ↔ ConfigMap ↔ TS reasons all in sync"
