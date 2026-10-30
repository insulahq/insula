#!/usr/bin/env bash
# Harness for the verified-installer fetch path in scripts/bootstrap.sh.
# Run: ./scripts/test-bootstrap-installer-verify.sh   (exit 0 = all pass)
#
# WHY THIS EXISTS
#
# `fetch_verified_script` is unusual: its STDOUT IS A PAYLOAD, piped straight
# into `sh`. That makes the usual "just log the error" reflex actively
# dangerous, and it failed exactly that way on a real production install:
#
#     public-underlay mode: --node-ip=…
#     : not found
#     sh: 2: url:: not found
#     sh: 3: expected:: not found
#     sh: 8: Syntax error: "(" unexpected
#
# The checksum guard had fired correctly (upstream published a new get.k3s.io),
# but it reported through error() → ui_fail(), and in RICH mode every ui_*
# emitter prints to STDOUT by design. So the human-readable failure text was
# captured by the caller's `$(...)` and piped into `sh`, which tried to execute
# it line by line. The guard that says "refusing to execute" printed garbage and
# let the install continue.
#
# These assertions run the SHIPPED function against the real endpoint. They are
# cheap (one HTTPS GET) and they pin the property that matters: on any failure
# the payload channel stays empty, so there is nothing for `sh` to run.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
has()  { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 — not found: $2"; fi; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# Extract the shipped implementation verbatim — testing a copy would let the
# real one drift away from these guarantees.
sed -n '/^_fvs_fail()/,/^}/p'            "$BOOTSTRAP" >  "$WORK/f.sh"
sed -n '/^fetch_verified_script()/,/^}/p' "$BOOTSTRAP" >> "$WORK/f.sh"
for fn in _fvs_fail fetch_verified_script; do
  grep -q "^${fn}()" "$WORK/f.sh" || { echo "FAIL: could not extract ${fn}() from $BOOTSTRAP" >&2; exit 1; }
done

# The URL bootstrap.sh actually fetches: the installer at the PINNED k3s tag.
# get.k3s.io serves master's install.sh and drifts on every upstream publish —
# comparing the pin against it reported a stale pin while bootstrap was fine.
K3S_VERSION_PIN=$(grep -E '^K3S_VERSION=' "$BOOTSTRAP" | cut -d'"' -f2)
URL="https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION_PIN}/install.sh"
PINNED=$(grep -E '^K3S_INSTALLER_SHA256=' "$BOOTSTRAP" | cut -d'"' -f2)

echo "fetch_verified_script — failure must not contaminate the payload channel"

# THE regression: a mismatch must leave stdout empty. If anything lands there it
# gets piped into `sh`.
out=$(bash -c "source '$WORK/f.sh'; fetch_verified_script $URL deadbeefdeadbeef k3s" 2>/dev/null); rc=$?
check "mismatch exits non-zero"                    "1" "$rc"
check "mismatch writes ZERO bytes to stdout"       "0" "${#out}"

err=$(bash -c "source '$WORK/f.sh'; fetch_verified_script $URL deadbeefdeadbeef k3s" 2>&1 >/dev/null)
has "$err" "checksum MISMATCH"  "the operator still gets the reason (on stderr)"
has "$err" "url:"               "stderr names the URL"
has "$err" "expected:"          "stderr names the expected digest"
has "$err" "INSTALLER_SHA256"   "stderr says which pin to update"

# The failure path must not route through error()/ui_fail(): in rich mode those
# print to stdout, which is the payload.
body=$(sed -n '/^fetch_verified_script()/,/^}/p' "$BOOTSTRAP")
if grep -qE '(^|[^_[:alnum:]])error[[:space:]]+"' <<<"$body"; then
  bad "fetch_verified_script must not call error() — ui_fail writes to STDOUT in rich mode"
else
  ok "fetch_verified_script does not call error() (payload channel stays clean)"
fi

echo ""
echo "pin freshness + happy path"

# A stale pin is a real, recurring event (upstream re-publishes get.k3s.io). This
# turns "every fresh install dies" into one obviously-red assertion.
live=$(curl --retry 2 -fsSL "$URL" 2>/dev/null | sha256sum | awk '{print $1}')
if [[ -z "$live" ]]; then
  echo "  ⊘ SKIP pin-freshness — could not reach $URL"
else
  check "K3S_INSTALLER_SHA256 matches the live installer" "$live" "$PINNED"
  good=$(bash -c "source '$WORK/f.sh'; fetch_verified_script $URL $live k3s" 2>/dev/null); grc=$?
  check "matching digest exits 0" "0" "$grc"
  if [[ "${#good}" -gt 1000 && "${good:0:9}" == "#!/bin/sh" ]]; then
    ok "matching digest still delivers the installer on stdout"
  else
    bad "matching digest should deliver the installer (${#good} bytes, head='${good:0:20}')"
  fi
fi

# Helm's and Flux's installers, at the tags bootstrap.sh fetches them from.
# Flux's used to come from fluxcd.io/install.sh, which follows flux2's main
# branch: a comment fix there changed its digest and every fresh install
# stopped at install_flux while nothing ran this file. CI runs it now, on
# every bootstrap.sh change and weekly (component-watch.yml).
HELM_REF=$(grep -E '^HELM_INSTALLER_REF=' "$BOOTSTRAP" | cut -d'"' -f2)
FLUX_VERSION_PIN=$(grep -E '^FLUX_VERSION=' "$BOOTSTRAP" | cut -d'"' -f2)
for row in \
  "HELM_INSTALLER_SHA256|https://raw.githubusercontent.com/helm/helm/${HELM_REF}/scripts/get-helm-3" \
  "FLUX_INSTALLER_SHA256|https://raw.githubusercontent.com/fluxcd/flux2/v${FLUX_VERSION_PIN}/install/flux.sh"; do
  var=${row%%|*}; url=${row#*|}
  pin=$(grep -E "^${var}=" "$BOOTSTRAP" | cut -d'"' -f2)
  if [[ "$pin" =~ ^[0-9a-f]{64}$ ]]; then ok "$var is a sha256"; else bad "$var is not a sha256: [$pin]"; fi
  got=$(curl --retry 2 -fsSL "$url" 2>/dev/null | sha256sum | awk '{print $1}')
  if [[ -z "$got" || "$got" == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]]; then
    echo "  ⊘ SKIP $var freshness — could not reach $url"
  else
    check "$var matches the installer at $url" "$got" "$pin"
  fi
done
has "$(grep -F 'fetch_verified_script "https://raw.githubusercontent.com/fluxcd/flux2/v${FLUX_VERSION}/install/flux.sh"' "$BOOTSTRAP")" \
  'fluxcd/flux2/v${FLUX_VERSION}' "install_flux fetches the installer at the FLUX_VERSION tag, not fluxcd.io/install.sh"

echo ""
echo "call sites — an empty payload must never reach sh"
sites=$(grep -c 'installer="$(fetch_verified_script' "$BOOTSTRAP")
guards=$(grep -c 'installer payload — refusing to execute' "$BOOTSTRAP")
if (( guards >= sites )); then
  ok "every fetch call site guards against an empty payload ($guards guard(s), $sites site(s))"
else
  bad "only $guards of $sites fetch call sites guard against an empty payload"
fi

echo
printf 'installer-verify: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
