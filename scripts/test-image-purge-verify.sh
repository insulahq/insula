#!/usr/bin/env bash
# test-image-purge-verify.sh — the image-purge script must VERIFY removal.
#
# THE BUG THIS PINS
#   The purge script mapped `crictl rmi` answering "no such image" straight to
#   REMOVED:
#       case "$out" in
#         *"no such image"*|*"not found"*) echo "REMOVED:$img" ;;
#   That message is AMBIGUOUS. It means both "already gone" (success) and "this
#   ref does not resolve on this runtime" — and in the second case the image is
#   still on disk. The reaper then recorded succeeded=true with bytes_reclaimed
#   copied from kubelet's node status, a figure it never measured.
#
#   Caught 2026-08-04: a digest ref (…/php@sha256:…) produced a "successful"
#   reap at delete+306s and the image was still listed on the node 24s later.
#   The integration suite reported it as "reaper did not fire", which sent the
#   investigation at the scheduler rather than at the false success.
#
# THE RULE
#   Removal is confirmed by asking the runtime, not by parsing the rmi message:
#   `crictl images -q <ref>` prints an image ID when the ref resolves and
#   nothing when it does not, so empty output is proof of absence.
#
# Runs the REAL script extracted from service.ts against a stub crictl — a
# string assertion would not catch a logic change.
#
# Exit: 0 all cases pass · 1 a case failed
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/backend/src/modules/storage/service.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[[ -r "$SRC" ]] || { echo "cannot read $SRC" >&2; exit 1; }

# ── Extract the embedded purge script and make it runnable here ──────────────
python3 - "$SRC" "$TMP/purge.sh" <<'PY'
import sys
src = open(sys.argv[1]).read()
anchor = 'cat > /var/lib/rancher/k3s/agent/etc/crictl.yaml'
i = src.index(anchor)
j = src.index('`;', i)
tpl = src[src.rindex('`', 0, i) + 1 : j]
sh = tpl.replace('${imageList}', "'ghcr.io/example/app@sha256:deadbeef'")
# The template also interpolates the containerd socket path.
sh = sh.replace('${CONTAINERD_SOCKET_PATH}', '$TESTSOCK')
# Undo JS template-literal escaping to recover the real shell source.
sh = sh.replace('\\$', '$').replace('\\`', '`').replace('\\\\n', '\\n')
# The script writes a crictl config under an absolute k3s path; redirect it.
sh = sh.replace('/var/lib/rancher/k3s/agent/etc', '"$TESTROOT"')
open(sys.argv[2], 'w').write(sh)
PY

fails=0
run_case() {
  local name="$1" rmi_out="$2" rmi_rc="$3" images_q="$4" expect="$5"
  local bin="$TMP/bin"; rm -rf "$bin" "$TMP/root"; mkdir -p "$bin" "$TMP/root"; : > "$TMP/imgcalls"
  # The script refuses to run without a containerd socket ([ ! -S ]), so make a
  # real one — a plain file would not satisfy the test.
  python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "$TMP/root/cri.sock" 2>/dev/null || true
  cat > "$bin/crictl" <<EOF
#!/usr/bin/env bash
case "\$1" in
  rmi)
    # --prune is the script's first call; always succeed so the case under
    # test is the per-image rmi that follows.
    [[ "\$2" == "--prune" ]] && exit 0
    printf '%s\n' "$rmi_out"; exit $rmi_rc ;;
  images)
    # "$images_q" of the form "delayN" means: still present for the first N
    # checks, absent afterwards — i.e. containerd settling asynchronously.
    case "$images_q" in
      delay*)
        n=${images_q#delay}
        c=\$(cat "$TMP/imgcalls" 2>/dev/null || echo 0)
        c=\$((c + 1)); echo "\$c" > "$TMP/imgcalls"
        [ "\$c" -le "\$n" ] && printf 'sha256:abc123'
        ;;
      *) printf '%s' "$images_q" ;;
    esac ;;
esac
exit 0
EOF
  chmod +x "$bin/crictl"
  local out
  out="$(PATH="$bin:$PATH" TESTROOT="$TMP/root" TESTSOCK="$TMP/root/cri.sock" bash "$TMP/purge.sh" 2>&1)"
  if grep -q "$expect" <<<"$out"; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s — expected %s, got: %s\n' "$name" "$expect" "$(tr '\n' ' ' <<<"$out" | head -c 160)" >&2
    fails=$((fails + 1))
  fi
}

echo "image-purge verification:"

# The regression: rmi cannot resolve the ref, but the image IS still present.
# Pre-fix this printed REMOVED and the reaper logged a successful reap.
run_case "unresolvable ref + image still present → FAILED" \
  "FATA[0000] no such image \"ghcr.io/example/app@sha256:deadbeef\"" 1 "sha256:abc123" "FAILED:"

# Genuinely already gone — rmi says the same thing, but the runtime agrees it
# is absent, so this must still be a success (idempotent reap).
run_case "unresolvable ref + image absent → REMOVED" \
  "FATA[0000] no such image \"ghcr.io/example/app@sha256:deadbeef\"" 1 "" "REMOVED:"

# Normal path.
run_case "rmi succeeds + image absent → REMOVED" \
  "Deleted: ghcr.io/example/app@sha256:deadbeef" 0 "" "REMOVED:"

# rmi claims success but the image survives (partial/failed delete).
run_case "rmi 'succeeds' but image survives → FAILED" \
  "Deleted: ghcr.io/example/app@sha256:deadbeef" 0 "sha256:abc123" "FAILED:"

# THE REGRESSION: verifying once immediately after rmi reported a reap that had
# actually succeeded as FAILED, because containerd had not settled yet. The
# check must poll before concluding.
run_case "removal settles after 2 checks → REMOVED (not a false failure)" \
  "Deleted: ghcr.io/example/app@sha256:deadbeef" 0 "delay2" "REMOVED:"

if (( fails > 0 )); then
  echo "❌ test-image-purge-verify: $fails case(s) failed" >&2
  exit 1
fi
echo "✅ test-image-purge-verify: removal is verified against the runtime, not inferred from the rmi message."
