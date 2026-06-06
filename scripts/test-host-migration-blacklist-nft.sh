#!/usr/bin/env bash
# Clean-room test for 0001-firewall-blacklist-nft.sh. Needs nftables + NET_ADMIN
# (the migration applies SURGICALLY to the LIVE ruleset, so the test loads a
# ruleset into the kernel and inspects the live result — not just file edits).
#
# Asserts: (1) old-style live ruleset + conf gets sets+rules added surgically at
# the right position and the conf persisted; (2) re-run is a no-op (no dup);
# (3) a conf that already declares the sets is a no-op; (4) missing conf skip.
# CRUCIAL: the migration must NOT `flush ruleset` — we seed a marker table and
# assert it survives (a whole-ruleset reload would wipe it, breaking CNI).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$HERE/platform/host-migrations/2026.6.3/0001-firewall-blacklist-nft.sh"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }

old_conf() {
cat <<'NFT'
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  set crowdsec_blocklist_v4 {
    type ipv4_addr
    flags interval,timeout
  }
  set crowdsec_blocklist_v6 {
    type ipv6_addr
    flags interval,timeout
  }
  chain input {
    type filter hook input priority filter; policy drop;
    iif "lo" accept
    ct state established,related accept
    ip  saddr @crowdsec_blocklist_v4 drop
    ip6 saddr @crowdsec_blocklist_v6 drop
    tcp dport 22 accept
  }
}
NFT
}

# Load a ruleset into the LIVE kernel + a marker table a `flush ruleset` wipes.
load_live() { nft -f "$1"; nft add table inet marker_canary 2>/dev/null || true; }
run_migration() { CONF="$1" bash -c 'sed "s#/etc/nftables.conf#$CONF#g" "$0" | bash' "$SCRIPT"; }

echo "== Test 1: surgical add to live + persist to conf =="
T=$(mktemp); old_conf > "$T"; load_live "$T"
run_migration "$T"
live="$(nft list chain inet filter input)"
grep -q '@blacklist_v4 drop' <<<"$live" && ok "live: blacklist_v4 drop added" || no "live drop missing"
nft list set inet filter blacklist_v4 >/dev/null 2>&1 && ok "live: blacklist_v4 set created" || no "live set missing"
nft list table inet marker_canary >/dev/null 2>&1 && ok "marker_canary survived (no flush ruleset)" || no "CANARY WIPED — migration flushed the whole ruleset!"
ln="$(nft -a list chain inet filter input)"
ct=$(grep -n 'ct state established' <<<"$ln" | head -1 | cut -d: -f1)
bl=$(grep -n '@blacklist_v4 drop' <<<"$ln" | head -1 | cut -d: -f1)
cs=$(grep -n '@crowdsec_blocklist_v4 drop' <<<"$ln" | head -1 | cut -d: -f1)
ac=$(grep -n 'tcp dport 22 accept' <<<"$ln" | head -1 | cut -d: -f1)
{ [[ "$bl" -gt "$ct" && "$bl" -lt "$cs" && "$bl" -lt "$ac" ]]; } && ok "live ordering ct<blacklist<crowdsec<accept" || no "bad live ordering ct=$ct bl=$bl cs=$cs ac=$ac"
grep -qE '^\s*set blacklist_v4 \{' "$T" && ok "conf: set persisted" || no "conf set missing"
grep -qE '@blacklist_v4 drop' "$T" && ok "conf: drop persisted" || no "conf drop missing"

echo "== Test 2: re-run is a no-op (idempotent, no dup) =="
B=$(sha256sum "$T" | awk '{print $1}')
run_migration "$T" | grep -q "no-op" && ok "re-run no-op" || no "re-run not no-op"
[[ "$B" == "$(sha256sum "$T" | awk '{print $1}')" ]] && ok "conf unchanged on re-run" || no "conf changed"
n=$(nft list chain inet filter input | grep -c '@blacklist_v4 drop')
[[ "$n" -eq 1 ]] && ok "exactly one live drop rule (no dup)" || no "duplicate live drop rules: $n"
nft flush ruleset; rm -f "$T"

echo "== Test 3: fresh install (conf declares sets AND live has them) → no-op =="
# A conf that declares the blacklist sets + drop rules — and is LOADED into the
# live kernel (as a fresh bootstrap would). Both complete → no-op.
T=$(mktemp)
old_conf \
  | sed 's/  set crowdsec_blocklist_v4 {/  set blacklist_v4 {\n    type ipv4_addr\n    flags interval\n  }\n  set blacklist_v6 {\n    type ipv6_addr\n    flags interval\n  }\n  set crowdsec_blocklist_v4 {/' \
  | sed 's/    ip  saddr @crowdsec_blocklist_v4 drop/    ip  saddr @blacklist_v4 drop\n    ip6 saddr @blacklist_v6 drop\n    ip  saddr @crowdsec_blocklist_v4 drop/' > "$T"
load_live "$T"
B=$(sha256sum "$T" | awk '{print $1}')
run_migration "$T" | grep -q "no-op" && ok "fresh (conf+live complete) → no-op" || no "not no-op"
[[ "$B" == "$(sha256sum "$T" | awk '{print $1}')" ]] && ok "conf unchanged" || no "conf changed"
nft flush ruleset; rm -f "$T"

echo "== Test 3b: conf declares sets but LIVE is missing them → REPAIRS live (not no-op) =="
# MEDIUM-2: a partial prior run (file written, live apply failed) must self-heal
# the kernel on re-run rather than falsely no-op'ing on the file alone.
T=$(mktemp)
old_conf \
  | sed 's/  set crowdsec_blocklist_v4 {/  set blacklist_v4 {\n    type ipv4_addr\n    flags interval\n  }\n  set blacklist_v6 {\n    type ipv6_addr\n    flags interval\n  }\n  set crowdsec_blocklist_v4 {/' \
  | sed 's/    ip  saddr @crowdsec_blocklist_v4 drop/    ip  saddr @blacklist_v4 drop\n    ip6 saddr @blacklist_v6 drop\n    ip  saddr @crowdsec_blocklist_v4 drop/' > "$T"
# load only the OLD shape into live (no blacklist) — simulates the live apply
# having failed after the file was written.
old_conf | nft -f -; nft add table inet marker_canary 2>/dev/null || true
out="$(run_migration "$T")"
grep -q "backfilled" <<<"$out" && ok "incomplete-live → repaired (backfilled)" || no "did not repair: $out"
nft list set inet filter blacklist_v4 >/dev/null 2>&1 && ok "live set now present" || no "live set still missing"
nft list table inet marker_canary >/dev/null 2>&1 && ok "marker survived repair (still surgical)" || no "CANARY WIPED on repair"
nft flush ruleset; rm -f "$T"

echo "== Test 4: missing conf → graceful skip =="
run_migration "/nonexistent/nftables.conf" | grep -q "skipping" && ok "missing conf skipped" || no "not skipped"

echo
echo "RESULT: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
