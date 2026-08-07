#!/usr/bin/env bash
# test-pin-config-image.sh — unit tests for the ConfigMap image pinner.
#
# This script edits a file that decides which binary runs against the production
# mail store, then commits and pushes it. The failure modes that matter are the
# quiet ones: accepting a mutable reference, or "succeeding" against a key that
# does not exist (which leaves the backend on its in-code `:latest` default while
# CI reports a green pin). Both are pinned here.
#
# Runs entirely on throwaway git repos in a temp dir with PIN_PUSH=0 — nothing
# touches the real repo or any remote.
#
# Exit: 0 all pass · 1 any failure
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/pin-config-image.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
DIGEST="sha256:$(printf 'a%.0s' $(seq 1 64))"
GOOD_REF="ghcr.io/insulahq/insula/rocksdb-secondary-checkpoint:20260807103130-abc1234@${DIGEST}"

# make_repo <dir> — a minimal repo with the overlay patch the script edits.
make_repo() {
  local d="$1"
  mkdir -p "$d/k8s/overlays/development"
  cat > "$d/k8s/overlays/development/platform-config-patch.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: platform-config
data:
  file-manager-image: "ghcr.io/insulahq/insula/file-manager:latest"
  rocksdb-secondary-checkpoint-image: "ghcr.io/insulahq/insula/rocksdb-secondary-checkpoint:latest"
YAML
  git -C "$d" init -q 2>/dev/null
  git -C "$d" config user.email t@example.test
  git -C "$d" config user.name t
  git -C "$d" add -A && git -C "$d" commit -qm init
}

# check <name> <expected-rc> [args...]
check() {
  local name="$1" want="$2"; shift 2
  local d="$TMP/repo-$((pass + fail))"
  make_repo "$d"
  local out rc
  out="$(ROOT="$d" PIN_PUSH=0 bash "$SCRIPT" "$@" 2>&1)"; rc=$?
  if [[ "$rc" == "$want" ]]; then
    echo "  ✅ $name (rc=$rc)"; pass=$((pass + 1))
  else
    echo "  ❌ $name — expected rc=$want, got rc=$rc" >&2
    printf '%s\n' "$out" | sed 's/^/       /' >&2
    fail=$((fail + 1))
  fi
  LAST_DIR="$d"
}

echo "── rejects references that are not immutable ─────────────────────────"
# THE point of the script. A tag-only ref would pin nothing of value.
check "tag-only ref is REFUSED" 2 rocksdb-secondary-checkpoint-image \
  "ghcr.io/insulahq/insula/rocksdb-secondary-checkpoint:20260807103130-abc1234"
check "bare :latest is REFUSED" 2 rocksdb-secondary-checkpoint-image \
  "ghcr.io/insulahq/insula/rocksdb-secondary-checkpoint:latest"
check "digest without a tag is REFUSED" 2 rocksdb-secondary-checkpoint-image \
  "ghcr.io/insulahq/insula/rocksdb-secondary-checkpoint@${DIGEST}"
check "truncated digest is REFUSED" 2 rocksdb-secondary-checkpoint-image \
  "ghcr.io/insulahq/insula/x:t@sha256:abc123"

echo "── refuses to silently no-op ─────────────────────────────────────────"
# A missing key means the backend is still on its in-code default; reporting
# success there would be a green check over a pin that does nothing.
check "unknown config key FAILS (does not no-op)" 1 no-such-image-key "$GOOD_REF"

echo "── input validation ──────────────────────────────────────────────────"
check "missing args → usage" 2
check "bad key characters rejected" 2 'Bad_Key;rm -rf /' "$GOOD_REF"

echo "── the happy path ────────────────────────────────────────────────────"
check "valid tag@digest pins" 0 rocksdb-secondary-checkpoint-image "$GOOD_REF"
if grep -q "rocksdb-secondary-checkpoint-image: \"${GOOD_REF}\"" \
     "$LAST_DIR/k8s/overlays/development/platform-config-patch.yaml"; then
  echo "  ✅ value written exactly"; pass=$((pass + 1))
else
  echo "  ❌ value not written as expected" >&2
  grep rocksdb "$LAST_DIR/k8s/overlays/development/platform-config-patch.yaml" >&2
  fail=$((fail + 1))
fi
# Neighbouring keys must not be collateral damage — the sed is line-scoped.
if grep -q 'file-manager-image: "ghcr.io/insulahq/insula/file-manager:latest"' \
     "$LAST_DIR/k8s/overlays/development/platform-config-patch.yaml"; then
  echo "  ✅ other keys untouched"; pass=$((pass + 1))
else
  echo "  ❌ an adjacent key was modified" >&2; fail=$((fail + 1))
fi

echo "── idempotence ───────────────────────────────────────────────────────"
# Re-pinning the same ref must be a clean no-op, not an empty commit.
# Commit the first pin first: the script decides "already pinned" by diffing
# against HEAD, and PIN_PUSH=0 deliberately stops before committing. In CI each
# run commits, so without this the test would be asking a question that cannot
# arise — and would fail on a script that is behaving correctly.
git -C "$LAST_DIR" commit -qam "pin" 2>/dev/null
out="$(ROOT="$LAST_DIR" PIN_PUSH=0 bash "$SCRIPT" rocksdb-secondary-checkpoint-image "$GOOD_REF" 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$out" == *"nothing to do"* ]]; then
  echo "  ✅ re-pinning the same ref is a no-op"; pass=$((pass + 1))
else
  echo "  ❌ expected a no-op on re-pin (rc=$rc): $out" >&2; fail=$((fail + 1))
fi

echo
if (( fail > 0 )); then
  echo "❌ test-pin-config-image: $fail failed, $pass passed" >&2
  exit 1
fi
echo "✅ test-pin-config-image: all $pass checks passed"
