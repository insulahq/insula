#!/usr/bin/env bash
# test-destroy-iscsi-sweep.sh — the wipe path must log out Longhorn's iSCSI
# sessions, and ONLY Longhorn's.
#
# WHAT THIS PINS
#   k3s-uninstall.sh knows nothing about Longhorn, and Longhorn's own logout
#   lives in the CSI plugin's NodeUnstageVolume — never called when the cluster
#   is torn down underneath it. So kernel iSCSI sessions used to survive the wipe
#   AND the re-bootstrap (the host is not rebooted), each retrying login ~1/s
#   forever against a portal that answers "target not found". Measured on a
#   repeatedly-wiped VM: 44 sessions for 4 live volumes, ~3100 kernel msgs/min
#   on an idle cluster.
#
# THE RULES
#   1. Every session whose IQN carries the Longhorn prefix is logged out.
#   2. A session that is NOT Longhorn's is left alone — a node may hold an
#      external SAN with operator data, and an unfiltered `iscsiadm -m session -u`
#      would tear that down too.
#   3. A session that refuses to log out is reported loudly (it survives into the
#      next install) but must not abort the wipe.
#   4. No iscsiadm on the node is a clean skip, not an error.
#
# Runs the REAL block extracted from destroy-cluster.sh against a stub iscsiadm —
# a string assertion would not catch a logic change.
#
# Exit: 0 all cases pass · 1 a case failed
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/destroy-cluster.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[[ -r "$SRC" ]] || { echo "cannot read $SRC" >&2; exit 1; }

# ── Extract the sweep verbatim ───────────────────────────────────────────────
sed -n '/^LH_IQN_PREFIX=/,/^# Wipe K8s + Calico + Longhorn state directories$/p' "$SRC" \
  | sed '$d' > "$TMP/sweep.sh"
grep -q 'iscsiadm -m session -r' "$TMP/sweep.sh" || {
  echo "extraction failed — the sweep block moved or changed shape" >&2; exit 1; }

LH="iqn.2019-10.io.longhorn:"
fails=0

# stub iscsiadm: sessions live in $STATE; ids listed in $STUCK refuse logout.
make_stub() {
  local bin="$TMP/bin"; rm -rf "$bin"; mkdir -p "$bin"
  cat > "$bin/iscsiadm" <<'EOF'
#!/usr/bin/env bash
mode=""; sid=""; iqn=""; op=""; logout=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) mode="$2"; shift 2 ;;
    -r) sid="$2";  shift 2 ;;
    -T) iqn="$2";  shift 2 ;;
    -o) op="$2";   shift 2 ;;
    -u) logout=1;  shift ;;
    *) shift ;;
  esac
done
case "$mode" in
  session)
    if [[ $logout -eq 1 && -n "$sid" ]]; then
      grep -qx "$sid" "$STUCK" 2>/dev/null && exit 1
      # `|| true`, NOT `&&`: grep -v exits 1 when it selects NO lines, i.e. when
      # the session being removed was the LAST one. Guarding the mv on grep's
      # status therefore silently kept the final session and the stub reported
      # "3 logged out, 1 remaining".
      grep -v "^tcp: \[$sid\] " "$STATE" > "$STATE.new" || true
      mv "$STATE.new" "$STATE"
      exit 0
    fi
    cat "$STATE" 2>/dev/null; exit 0 ;;
  node) exit 0 ;;
esac
exit 0
EOF
  chmod +x "$bin/iscsiadm"
  printf '%s' "$bin"
}

run_case() {
  local name="$1" sessions="$2" stuck="$3" expect="$4" bin
  bin="$(make_stub)"
  printf '%s\n' "$sessions" | grep -vE '^$' > "$TMP/state"
  printf '%s\n' "$stuck" | grep -vE '^$' > "$TMP/stuck"
  local out
  out="$(PATH="$bin:$PATH" STATE="$TMP/state" STUCK="$TMP/stuck" bash "$TMP/sweep.sh" 2>&1)"
  if grep -qE "$expect" <<<"$out"; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s\n      expected /%s/\n      got: %s\n' "$name" "$expect" "$(tr '\n' ' ' <<<"$out")" >&2
    fails=$((fails + 1))
  fi
  printf '%s' "$out" > "$TMP/last_out"
}

echo "destroy-cluster iSCSI sweep:"

# 1. The regression: orphans left by a previous install must all go.
run_case "3 longhorn sessions → all logged out" \
"tcp: [1] 10.42.0.5:3260,1 ${LH}pvc-aaa (non-flash)
tcp: [2] 10.42.0.5:3260,1 ${LH}pvc-bbb (non-flash)
tcp: [281] 10.42.0.6:3260,1 ${LH}pvc-ccc (non-flash)" \
"" \
"3 before, 3 logged out, 0 remaining"

# 2. An operator's external SAN must survive the wipe.
run_case "non-longhorn SAN session is NOT touched" \
"tcp: [1] 10.42.0.5:3260,1 ${LH}pvc-aaa (non-flash)
tcp: [9] 192.0.2.7:3260,1 iqn.2001-04.com.example:storage.disk1 (non-flash)" \
"" \
"1 before, 1 logged out, 0 remaining"
if grep -q 'com.example:storage.disk1' "$TMP/state"; then
  printf '  ✓ %s\n' "  …and the SAN session is still present afterwards"
else
  printf '  ✗ %s\n' "  SAN session was logged out — unfiltered teardown" >&2
  fails=$((fails + 1))
fi

# 3. A stuck session must warn (it survives into the next install) but not abort.
run_case "session that refuses to log out → loud warning" \
"tcp: [1] 10.42.0.5:3260,1 ${LH}pvc-aaa (non-flash)
tcp: [2] 10.42.0.5:3260,1 ${LH}pvc-bbb (non-flash)" \
"2" \
"WARNING: 1 longhorn iscsi session\(s\) would NOT log out"

# 4. Nothing to do is not an error.
run_case "no sessions at all → clean no-op" "" "" "0 before, 0 logged out, 0 remaining"

# 5. A node without open-iscsi must skip cleanly. Use the ambient PATH minus the
# stub dir — the sweep still needs bash/grep/sed, and iscsiadm is genuinely
# absent here (asserted below, so this case can never pass vacuously).
if command -v iscsiadm >/dev/null 2>&1; then
  echo "  ! skipping the no-iscsiadm case: iscsiadm IS installed on this host" >&2
else
out="$(STATE="$TMP/state" STUCK="$TMP/stuck" bash "$TMP/sweep.sh" 2>&1)"
if grep -q 'iscsiadm not present' <<<"$out"; then
  printf '  ✓ %s\n' "no iscsiadm on the node → clean skip"
else
  printf '  ✗ %s — got: %s\n' "no iscsiadm on the node → clean skip" "$out" >&2
  fails=$((fails + 1))
fi
fi

if (( fails > 0 )); then
  echo "❌ test-destroy-iscsi-sweep: $fails case(s) failed" >&2
  exit 1
fi
echo "✅ test-destroy-iscsi-sweep: the wipe logs out Longhorn's iSCSI sessions and only those."
