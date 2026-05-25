#!/usr/bin/env bash
set -euo pipefail

# ci-k8s-patch-check.sh — fail CI when a backend module calls
# patchNamespaced* / patchClusterCustomObject without an explicit
# Content-Type override.
#
# Background: @kubernetes/tenant-node v1.4 always sends
# `application/json-patch+json` (RFC 6902 op array) by default — every
# patch method bakes that as the first entry of its `consumes` list,
# and ObjectSerializer.getPreferredMediaType picks the first entry. A
# caller that passes a merge-object body (`{ data: {...} }`) without
# overriding the header gets:
#
#   error decoding patch: json: cannot unmarshal object into
#   Go value of type []handlers.jsonPatchOp
#
# The HIGH-3 finding from the Cut 3 mail review (commit 855b443) was a
# real regression of this flavour — and the diagnosis was the OPPOSITE
# of the actual default, so the "fix" introduced a new bug.
#
# Enforcement: every patchNamespaced* / patchClusterCustomObject call in
# backend/src — except inside `shared/k8s-patch.ts` itself and `*.test.ts`
# files — MUST be accompanied (within ~10 lines) by one of the explicit
# middleware shims:
#   • MERGE_PATCH            — application/merge-patch+json (RFC 7396)
#   • STRATEGIC_MERGE_PATCH  — application/strategic-merge-patch+json
#   • JSON_PATCH             — application/json-patch+json (RFC 6902)
#   • applyPatch(fieldManager, …)  — application/apply-patch+yaml (SSA);
#                              callers usually module-scope the result
#                              as a const NAMED *_APPLY_PATCH that is
#                              passed to the patch call. The guard
#                              matches the apply-patch source OR
#                              identifiers ending in `_APPLY_PATCH`.
#
# All three are exported from `backend/src/shared/k8s-patch.ts`.
#
# This script does a textual scan, not an AST scan; the look-ahead window
# (LOOKAHEAD lines) covers multi-line call expressions. Tune if the codebase
# starts having genuinely longer patch invocations.
#
# Known limitation: this guard cannot catch indirected calls such as
#   const fn = k8s.core.patchNamespacedSecret.bind(k8s.core);
#   await fn({ name, namespace, body }); // no shim → CI guard misses
# If you ever store a patch method in a variable, you are responsible for
# threading the shim through manually.

LOOKAHEAD=25
ROOT="${1:-backend/src}"

if [ ! -d "$ROOT" ]; then
  echo "ci-k8s-patch-check: directory '$ROOT' not found"
  exit 2
fi

# Find every line that invokes a patch method (not a type alias / interface
# declaration). We exclude:
#   - shared/k8s-patch.ts          → the helpers themselves
#   - **/*.test.ts                 → tests
#   - lines where the method is followed by `:` (type position) instead of `(`
PATCH_METHODS='patchNamespaced[A-Za-z]+|patchClusterCustomObject'

# Collect candidate hits as "FILE:LINE" pairs.
mapfile -t HITS < <(
  grep -rnE "\.(${PATCH_METHODS})[[:space:]]*\(" "$ROOT" \
    --include='*.ts' \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude='*.test.ts' \
    | grep -v '/shared/k8s-patch\.ts' \
    | awk -F: '{ print $1 ":" $2 }'
)

FAIL=0
FAIL_LINES=()

for hit in "${HITS[@]}"; do
  FILE="${hit%%:*}"
  LINE="${hit##*:}"
  END=$((LINE + LOOKAHEAD))
  # Look at LOOKAHEAD lines starting from the call site for one of the shims.
  WINDOW=$(sed -n "${LINE},${END}p" "$FILE")
  # Match the legacy 3 content-type constants, OR any SCREAMING_SNAKE_CASE
  # identifier ending in _PATCH at the call site (this covers
  # *_APPLY_PATCH from apply-patch SSA, *_MERGE_PATCH / *_STRATEGIC_PATCH
  # from the strategic-merge helper, and pre-streamline module-local
  # *_PATCH constants like STALWART_PORTS_PATCH or MIGRATION_AFFINITY_PATCH),
  # OR an inline call to one of the helper functions.
  #
  # The general `[A-Z_]+_PATCH\b` clause is permissive but safe IFF the
  # constant is sourced from shared/k8s-patch.ts (or transitively from
  # withTag()). It is NOT safe if the constant is locally shadowed,
  # which happened in wal-suspend.ts (a plain `{ headers: {...} }` bag
  # that the SDK silently ignored). The check below catches this by
  # rejecting files that DEFINE a *_PATCH constant locally without
  # importing it from k8s-patch.ts.
  if echo "$WINDOW" | grep -qE '\b(MERGE_PATCH|STRATEGIC_MERGE_PATCH|JSON_PATCH|[A-Z_]+_PATCH|applyPatch\(|strategicMergePatch\()\b'; then
    continue
  fi
  FAIL=1
  FAIL_LINES+=("${FILE}:${LINE}")
done

# Shadow-name detector: any file that defines a local `const *_PATCH =`
# must NOT also call patchNamespaced* — the local definition will be the
# resolved name and silently bypass the SDK's middleware contract. If
# the file also imports a *_PATCH from k8s-patch.ts that's the canonical
# one and we let it pass; otherwise it's a bypass.
SHADOW_FAIL_LINES=()
while IFS= read -r FILE; do
  case "$FILE" in
    */shared/k8s-patch.ts) continue ;;  # the canonical definition lives here
    */node_modules/*) continue ;;
    */dist/*) continue ;;
  esac
  if grep -qE 'patchNamespaced|patchClusterCustomObject' "$FILE" \
     && grep -qE '^[[:space:]]*const[[:space:]]+[A-Z_]+_PATCH[[:space:]]*=' "$FILE" \
     && ! grep -qE "from '[^']*shared/k8s-patch" "$FILE"; then
    SHADOW_FAIL_LINES+=("$FILE")
    FAIL=1
  fi
done < <(find backend/src -name '*.ts' -not -name '*.test.ts')

if [ ${#SHADOW_FAIL_LINES[@]} -gt 0 ]; then
  echo "❌ ci-k8s-patch-check: local *_PATCH constants shadow the canonical export from shared/k8s-patch.ts."
  echo
  echo "  Affected files:"
  for s in "${SHADOW_FAIL_LINES[@]}"; do
    echo "    $s"
  done
  echo
  echo "  Fix: remove the local constant + import the canonical one:"
  echo "       import { MERGE_PATCH } from '../../shared/k8s-patch.js';"
  echo
  echo "  Why: the SDK's v1.x patch methods take a middleware-shaped"
  echo "       opts arg, not a plain headers bag. A locally-defined"
  echo "       \`{ headers: {...} }\` is silently ignored, the Content-"
  echo "       Type defaults to json-patch+json, and merge-object bodies"
  echo "       fail apiserver parsing."
fi

if [ $FAIL -ne 0 ]; then
  echo "❌ ci-k8s-patch-check: patchNamespaced* / patchClusterCustomObject call sites are missing an explicit Content-Type middleware shim."
  echo
  echo "  Affected sites:"
  for s in "${FAIL_LINES[@]}"; do
    echo "    $s"
    sed -n "${s##*:}p" "${s%%:*}" | sed 's|^|        |'
  done
  echo
  echo "  Fix: import one of MERGE_PATCH | STRATEGIC_MERGE_PATCH | JSON_PATCH | applyPatch() from"
  echo "       'backend/src/shared/k8s-patch.ts' and pass it as the second"
  echo "       positional argument to the patch call."
  echo
  echo "  Why: @kubernetes/tenant-node v1.4 defaults Content-Type to"
  echo "       'application/json-patch+json' regardless of body shape;"
  echo "       merge-object bodies without the override are rejected by"
  echo "       the apiserver with 'cannot unmarshal object into Go value"
  echo "       of type []handlers.jsonPatchOp'."
  exit 1
fi

echo "✅ ci-k8s-patch-check: ${#HITS[@]} patch call site(s) all carry an explicit Content-Type middleware."
