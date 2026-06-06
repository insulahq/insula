#!/usr/bin/env bash
# test-pin-image-tag.sh — unit tests for the internal-image pin helper.
# Validation + apply + idempotency are checked with PIN_PUSH=0; the commit +
# push + reset-and-reapply race loop is checked against a real bare-repo remote.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PIN="$HERE/pin-image-tag.sh"

pass=0 fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1" >&2; fail=$((fail + 1)); }

# seed_overlay DIR — a minimal repo working tree with one pinnable image entry.
seed_overlay() {
  mkdir -p "$1/k8s/overlays/development"
  cat > "$1/k8s/overlays/development/kustomization.yaml" <<'EOF'
images:
  - name: ghcr.io/insulahq/insula/myimage
    newTag: "latest"
  - name: ghcr.io/insulahq/insula/other
    newTag: "latest"
EOF
}

echo "[1] argument + format validation (exit 2)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; seed_overlay "$TMP"
( cd "$TMP" && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init )
ROOT="$TMP" PIN_PUSH=0 "$PIN" >/dev/null 2>&1;            [ $? -eq 2 ] && ok "missing args → 2" || bad "missing args"
ROOT="$TMP" PIN_PUSH=0 "$PIN" "Bad_Name" t1 >/dev/null 2>&1; [ $? -eq 2 ] && ok "bad image name → 2" || bad "bad image name"
ROOT="$TMP" PIN_PUSH=0 "$PIN" myimage 'bad tag!' >/dev/null 2>&1; [ $? -eq 2 ] && ok "bad tag → 2" || bad "bad tag"

echo "[2] no images: entry → exit 1"
ROOT="$TMP" PIN_PUSH=0 "$PIN" ghost deadbeef >/dev/null 2>&1; [ $? -eq 1 ] && ok "unknown image → 1" || bad "unknown image"

echo "[3] apply (PIN_PUSH=0) rewrites only the matched entry + idempotent"
ROOT="$TMP" PIN_PUSH=0 "$PIN" myimage 20260606120000-abc1234 >/dev/null
grep -q 'newTag: "20260606120000-abc1234"' "$TMP/k8s/overlays/development/kustomization.yaml" && ok "myimage pinned" || bad "myimage not pinned"
# 'other' must be untouched (still latest)
otherline=$(grep -A1 '/other$' "$TMP/k8s/overlays/development/kustomization.yaml" | grep newTag)
echo "$otherline" | grep -q '"latest"' && ok "other image untouched" || bad "other image changed: $otherline"
# idempotent: once the tag is committed (the real CI flow re-checks out main),
# re-pinning the same tag is a no-op. The script compares the working tree vs
# HEAD, so commit the first pin before re-running.
( cd "$TMP" && git add -A && git -c user.email=t@t -c user.name=t commit -qm pin )
ROOT="$TMP" PIN_PUSH=0 "$PIN" myimage 20260606120000-abc1234 >/tmp/pin_idem.txt 2>&1
grep -q 'already at' /tmp/pin_idem.txt && ok "re-pin same tag → no-op" || bad "idempotency: $(cat /tmp/pin_idem.txt)"

echo "[4] commit + push to a real remote"
RTMP=$(mktemp -d); trap 'rm -rf "$TMP" "$RTMP"' EXIT
ORIGIN="$RTMP/origin.git"; WORK="$RTMP/work"
git init -q --bare -b main "$ORIGIN"
git clone -q "$ORIGIN" "$WORK"
( cd "$WORK" && git config user.email t@t && git config user.name t && git checkout -q -b main )
seed_overlay "$WORK"
( cd "$WORK" && git add -A && git commit -qm init && git push -q -u origin main )
( cd "$WORK" && ROOT="$WORK" "$PIN" myimage 20260606130000-def5678 ) >/dev/null 2>&1
# origin main should now carry the pin commit
got=$(git -C "$ORIGIN" show main:k8s/overlays/development/kustomization.yaml | grep -A1 '/myimage$' | grep newTag)
echo "$got" | grep -q '20260606130000-def5678' && ok "origin main has the pin" || bad "origin missing pin: $got"

echo "[5] race recovery: first push rejected (origin advanced) → reset+reapply+repush"
# Advance origin via a SECOND clone with an UNRELATED change, so the work clone's
# push is non-fast-forward and the loop must reset onto it and re-apply the pin.
WORK2="$RTMP/work2"
git clone -q "$ORIGIN" "$WORK2"
( cd "$WORK2" && git config user.email t@t && git config user.name t \
   && echo "unrelated" > UNRELATED.txt && git add -A && git commit -qm "advance origin" && git push -q origin main )
# work clone is now behind origin; pin from there must converge via the loop.
( cd "$WORK" && ROOT="$WORK" "$PIN" myimage 20260606140000-aaa9999 ) >/tmp/pin_race.txt 2>&1
race_rc=$?
[ "$race_rc" -eq 0 ] && ok "pin converged despite stale local main" || bad "race rc=$race_rc: $(cat /tmp/pin_race.txt)"
# origin must have BOTH the unrelated commit AND the new pin
git -C "$ORIGIN" show main:UNRELATED.txt >/dev/null 2>&1 && ok "origin kept the concurrent unrelated commit" || bad "lost the concurrent commit"
got2=$(git -C "$ORIGIN" show main:k8s/overlays/development/kustomization.yaml | grep -A1 '/myimage$' | grep newTag)
echo "$got2" | grep -q '20260606140000-aaa9999' && ok "origin has the re-applied pin" || bad "origin missing re-applied pin: $got2"
rm -rf "$RTMP"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
