#!/usr/bin/env bash
# Harness for bootstrap.sh's outbound mail port preflight (check_outbound_mail_ports).
# Run: ./scripts/test-bootstrap-outbound-mail.sh   (exit 0 = all pass)
#
# Why this exists: a provider that blocks outbound TCP 25/465/587 on a server
# makes every send from it time out — a tenant app's mail, and on a mail node the
# mail server's own delivery — and nothing on the host shows it. A production
# node ran that way for days. The preflight says so before anything is installed;
# each verdict (open, blocked, unknown) is tested here against real sockets, and
# the message against canned results, so a check that can only pass is caught.
#
# The helpers are extracted from the SHIPPED script.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"

pass=0; fail=0
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
has()   { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 — not found: $2"; fi; }
hasnt() { if grep -qF -- "$2" <<<"$1"; then bad "$3 — unexpectedly found: $2"; else ok "$3"; fi; }

WORK="$(mktemp -d)"
LISTENER_PID=""
cleanup() { [[ -n "$LISTENER_PID" ]] && kill "$LISTENER_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

{
  grep -E '^OUTBOUND_MAIL_PROBE_TARGETS_DEFAULT=' "$BOOTSTRAP"
  sed -n '/^outbound_mail_port_status() {/,/^}/p' "$BOOTSTRAP"
  sed -n '/^check_outbound_mail_ports() {/,/^}/p' "$BOOTSTRAP"
} > "$WORK/helpers.sh"
grep -q '^check_outbound_mail_ports() {' "$WORK/helpers.sh" && grep -q '^outbound_mail_port_status() {' "$WORK/helpers.sh" \
  || { bad "helpers not found in bootstrap.sh"; echo "passed=$pass failed=$fail"; exit 1; }

# Sourced under the script's own shell options.
set -euo pipefail
UI_OUT="$WORK/ui"
ui_ok()   { printf 'OK %s\n' "$*" >> "$UI_OUT"; }
ui_warn() { printf 'WARN %s\n' "$*" >> "$UI_OUT"; }
log()     { printf 'LOG %s\n' "$*" >> "$UI_OUT"; }
# shellcheck disable=SC1091
source "$WORK/helpers.sh"
set +e

echo "── outbound_mail_port_status: real sockets ──"
python3 - "$WORK/port" <<'PY' &
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(16)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept(); c.close()
PY
LISTENER_PID=$!
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; sleep 0.1; done
OPEN_PORT=$(cat "$WORK/port")
CLOSED_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')

out=$(OUTBOUND_MAIL_DIAL_TIMEOUT=2 outbound_mail_port_status "$OPEN_PORT" "127.0.0.1")
check "a listening port is open, naming the target" "$OPEN_PORT open 127.0.0.1" "$out"

out=$(OUTBOUND_MAIL_DIAL_TIMEOUT=2 outbound_mail_port_status "$OPEN_PORT" "nonexistent.invalid,127.0.0.1")
check "an unresolvable first target falls through to the next" "$OPEN_PORT open 127.0.0.1" "$out"

out=$(OUTBOUND_MAIL_DIAL_TIMEOUT=2 outbound_mail_port_status "$CLOSED_PORT" "127.0.0.1")
check "a refused connection is a block" "$CLOSED_PORT blocked 127.0.0.1 refused or unreachable" "$out"

out=$(OUTBOUND_MAIL_DIAL_TIMEOUT=2 outbound_mail_port_status 25 "nonexistent.invalid,also-not.invalid")
check "no target resolving is unknown — no evidence about the port" \
  "25 unknown nonexistent.invalid did not resolve; also-not.invalid did not resolve" "$out"

out=$(OUTBOUND_MAIL_DIAL_TIMEOUT=2 outbound_mail_port_status 25 'bad;name,$(touch '"$WORK"'/pwned)')
has "$out" "is not a host name" "a host with shell characters is refused, not dialled"
[[ -e "$WORK/pwned" ]] && bad "…and it must never run" || ok "…and it never runs"

# A drop rule cannot be set up unprivileged; a fake `timeout` that answers 124
# (what coreutils returns when the dial hangs past the limit) stands in for it.
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 124\n' > "$WORK/bin/timeout"; chmod +x "$WORK/bin/timeout"
out=$(PATH="$WORK/bin:$PATH" OUTBOUND_MAIL_DIAL_TIMEOUT=5 outbound_mail_port_status 587 "127.0.0.1,localhost")
check "every target timing out is a block, per target" \
  "587 blocked 127.0.0.1 timed out after 5s; localhost timed out after 5s" "$out"

echo "── check_outbound_mail_ports: verdicts and message ──"
run_check() { : > "$UI_OUT"; check_outbound_mail_ports; echo "rc=$?" >> "$UI_OUT"; cat "$UI_OUT"; }

out=$(OUTBOUND_MAIL_PROBE_TARGETS="${OPEN_PORT}=127.0.0.1" run_check)
has "$out" "OK outbound mail ports open: ${OPEN_PORT}" "all open → ok"
has "$out" "rc=0" "…and returns 0"

# The whole check against real sockets, under bootstrap's options plus
# inherit_errexit: a failing dial must be recorded as a block, not end the
# background job that dials it (and with it the port's line) — guarded, not
# merely spared because a command substitution happens to clear errexit today.
out=$(set -euo pipefail; shopt -s inherit_errexit
      OUTBOUND_MAIL_DIAL_TIMEOUT=2 OUTBOUND_MAIL_PROBE_TARGETS="${OPEN_PORT}=127.0.0.1;${CLOSED_PORT}=127.0.0.1" run_check)
has "$out" "WARN outbound mail port(s) ${CLOSED_PORT} blocked from this server." "a refused port is reported blocked under errexit"
has "$out" "${CLOSED_PORT}: 127.0.0.1 refused or unreachable" "…with what the target answered"
has "$out" "rc=0" "…and the check returns 0"

out=$(OUTBOUND_MAIL_PROBE_TARGETS="" run_check)
has "$out" "LOG   outbound mail port check skipped" "an empty target list skips the check"
hasnt "$out" "WARN" "…without a warning"

# Canned per-port answers for the real mail ports: the message must say what
# each blocked port breaks, and the check must never be fatal.
outbound_mail_port_status() {
  case "$1" in
    25) echo "25 blocked gmail-smtp-in.l.google.com timed out after 5s" ;;
    465) echo "465 open smtp.gmail.com" ;;
    587) sleep 1; echo "587 blocked smtp.gmail.com timed out after 5s" ;;
  esac
}
out=$(run_check)
has "$out" "WARN outbound mail port(s) 25, 587 blocked from this server." "blocked ports are named in port order"
has "$out" "25: this server cannot deliver mail to other mail servers" "port 25 says the mail server cannot run here"
has "$out" "465/587: apps on this server cannot send through a mail server" "465/587 says apps cannot send"
has "$out" "Ask the provider to unblock outbound TCP 25, 465 and 587" "…and what to do"
has "$out" "25: gmail-smtp-in.l.google.com timed out after 5s" "…with what each target answered"
has "$out" "rc=0" "a block is a warning, not a fatal preflight failure"
hasnt "$out" "OK outbound" "…and no ok line"

outbound_mail_port_status() {
  case "$1" in
    25) echo "25 blocked mx.example.test timed out after 5s" ;;
    *) echo "$1 unknown a.example.test did not resolve" ;;
  esac
}
out=$(run_check)
has "$out" "WARN outbound mail port(s) 25 blocked from this server." "a block is reported when other ports are unchecked"
has "$out" "Port(s) 465, 587 could not be checked: no target answered DNS." "…and the unchecked ports are named in the same warning"

out=$(OUTBOUND_MAIL_PROBE_TARGETS="abc;25=mx.example.test" run_check)
has "$out" "WARN OUTBOUND_MAIL_PROBE_TARGETS has entries that are not port=host[,host…] (abc)" "a malformed entry says so, not 'no DNS answer'"
hasnt "$out" "could not check outbound mail port(s) abc" "…and is not reported as an unresolvable port"
has "$out" "WARN outbound mail port(s) 25 blocked" "…while the valid entries are still checked"

out=$(OUTBOUND_MAIL_PROBE_TARGETS="abc" run_check)
has "$out" "rc=0" "only malformed entries: warned, nothing else to report"
hasnt "$out" "OK outbound" "…and no ok line"

# An operator-supplied list is split on ';' only: a '*' must not glob-expand
# into whatever files sit in the working directory.
outbound_mail_port_status() { printf '%s\n' "$2" >> "$WORK/dialled"; echo "$1 open x"; }
mkdir -p "$WORK/globdir" && touch "$WORK/globdir/25=evil.example.test"
: > "$WORK/dialled"
(cd "$WORK/globdir" && OUTBOUND_MAIL_PROBE_TARGETS='25=*' run_check >/dev/null)
check "a '*' in the target list is not glob-expanded" "*" "$(cat "$WORK/dialled")"

outbound_mail_port_status() { sleep 2; echo "$1 open x"; }
start=$(date +%s)
out=$(run_check)
elapsed=$(( $(date +%s) - start ))
has "$out" "OK outbound mail ports open: 25, 465, 587" "the default targets cover 25, 465 and 587"
if (( elapsed < 5 )); then ok "the ports are dialled in parallel (${elapsed}s for 3 × 2s)"; else bad "the ports are dialled one after another (${elapsed}s)"; fi

outbound_mail_port_status() { echo "$1 unknown a did not resolve"; }
out=$(run_check)
has "$out" "WARN could not check outbound mail port(s) 25, 465, 587: no target answered DNS" "unresolvable targets are reported as unchecked, not blocked"

echo "── the same targets as the security-probe ──"
# Checked from both sides: images/security-probe/outboundmail_test.go runs when
# the probe changes, this when the scripts do.
probe_targets=$(python3 - "$REPO_ROOT/images/security-probe/outboundmail.go" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'defaultOutboundMailTargets\s*=\s*((?:"[^"]*"\s*\+?\s*)+)', src)
print("".join(re.findall(r'"([^"]*)"', m.group(1))) if m else "")
PY
)
check "bootstrap.sh's default targets equal the probe's" "$probe_targets" "$OUTBOUND_MAIL_PROBE_TARGETS_DEFAULT"

echo "── run_preflight calls it for every mode and role ──"
body=$(sed -n '/^run_preflight() {/,/^}/p' "$BOOTSTRAP")
has "$body" "  check_outbound_mail_ports" "run_preflight runs the check"
fatal_after=$(grep -A2 'check_outbound_mail_ports$' <<<"$body" | grep -c 'fatal=1' || true)
check "…and does not make it fatal" "0" "$fatal_after"

echo "passed=$pass failed=$fail"
(( fail == 0 ))
