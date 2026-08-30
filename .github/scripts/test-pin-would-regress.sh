#!/usr/bin/env bash
# test-pin-would-regress.sh — unit tests for the pin-regression guard.
#
# Reproduces the 2026-08-30 shape against a real git history: a slow build
# finishing after newer ones and trying to pin its own, older images over them.
# Exit 0 from the guard means "skip the pin".
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
GUARD="$HERE/pin-would-regress.sh"

pass=0 fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1" >&2; fail=$((fail + 1)); }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# A linear history: c1 → c2 → c3, plus a pin file we rewrite per case.
cd "$TMP"
git init -q
git config user.email t@t; git config user.name t
mkdir -p k8s/overlays/development
# mkdir every time: the overlay dir is untracked here, so a git checkout
# between cases removes it. Without this, a later case silently takes the
# "missing pin file → proceed" path and passes without testing anything.
write_pin() {
  mkdir -p k8s/overlays/development
  printf 'apiVersion: v1\ndata:\n  version: "2026.8.21-%s"\n' "$1" > k8s/overlays/development/platform-version-patch.yaml
}

echo "x" > f; git add -A; git commit -qm c1; C1=$(git rev-parse --short=7 HEAD)
echo "y" > f; git add -A; git commit -qm c2; C2=$(git rev-parse --short=7 HEAD)
echo "z" > f; git add -A; git commit -qm c3; C3=$(git rev-parse --short=7 HEAD)

echo "[1] the reported failure: an OLD build finishing after a NEWER pin"
write_pin "$C3"
BUILT_SHA="$C1" "$GUARD" >/dev/null 2>&1
[ $? -eq 0 ] && ok "c1 build vs c3 pin → skip" || bad "c1 build vs c3 pin should skip"

write_pin "$C3"
BUILT_SHA="$C2" "$GUARD" >/dev/null 2>&1
[ $? -eq 0 ] && ok "c2 build vs c3 pin → skip" || bad "c2 build vs c3 pin should skip"

echo "[2] the normal case: a NEW build over an older pin"
write_pin "$C1"
BUILT_SHA="$C3" "$GUARD" >/dev/null 2>&1
[ $? -eq 1 ] && ok "c3 build vs c1 pin → proceed" || bad "c3 build vs c1 pin should proceed"

echo "[3] re-applying the same commit is not a regression"
write_pin "$C2"
BUILT_SHA="$C2" "$GUARD" >/dev/null 2>&1
[ $? -eq 1 ] && ok "same sha → proceed (idempotent)" || bad "same sha should proceed"

echo "[4] fails OPEN rather than wedging deploys"
write_pin "deadbee"
BUILT_SHA="$C2" "$GUARD" >/dev/null 2>&1
[ $? -eq 1 ] && ok "unknown pinned sha → proceed" || bad "unknown pinned sha should proceed"

printf 'apiVersion: v1\ndata:\n  version: "not-a-version"\n' > k8s/overlays/development/platform-version-patch.yaml
BUILT_SHA="$C2" "$GUARD" >/dev/null 2>&1
[ $? -eq 1 ] && ok "unparseable version → proceed" || bad "unparseable version should proceed"

rm -f k8s/overlays/development/platform-version-patch.yaml
BUILT_SHA="$C2" "$GUARD" >/dev/null 2>&1
[ $? -eq 1 ] && ok "missing pin file → proceed (first pin)" || bad "missing pin file should proceed"

write_pin "$C3"
BUILT_SHA="" GITHUB_SHA="" "$GUARD" >/dev/null 2>&1
[ $? -eq 1 ] && ok "no BUILT_SHA → proceed" || bad "no BUILT_SHA should proceed"

echo "[5] a sibling branch is not an ancestor — unrelated work must still pin"
git checkout -qb side "$C1"
echo "s" > g; git add -A; git commit -qm side; SIDE=$(git rev-parse --short=7 HEAD)
git checkout -q -
write_pin "$SIDE"
[ -f k8s/overlays/development/platform-version-patch.yaml ] || bad "case 5 lost its pin file — would pass vacuously"
out=$(BUILT_SHA="$C3" "$GUARD" 2>&1); rc=$?
[ $rc -eq 1 ] && ok "c3 vs unrelated side pin → proceed" || bad "unrelated pin should proceed"
case "$out" in *"not an ancestor"*) ok "case 5 exercised the ancestry check" ;;
  *) bad "case 5 did not reach the ancestry check: $out" ;; esac

echo
echo "pin-would-regress: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
