#!/usr/bin/env bash
# idempotent: no-op when /etc/nftables.conf already declares `set blacklist_v4`
#   (fresh installs render it via bootstrap.sh). On clusters bootstrapped
#   before the operator-blacklist feature it inserts the two sets + two drop
#   rules, validates the result with `nft -c` BEFORE swapping (never applies a
#   broken ruleset), then reloads. Re-running after success hits the guard.
# allow-paths: /etc/nftables.conf
#
# Backfills the firewall-blacklist nft objects onto existing nodes. The
# firewall-reconciler manages blacklist_v{4,6} SET MEMBERSHIP, but the set
# DECLARATIONS + `ip saddr @blacklist_v{4,6} drop` rules are bootstrap-rendered
# into /etc/nftables.conf — so a cluster bootstrapped before the feature has no
# place for the reconciler's bans to land. This is the one-time backfill (same
# split CrowdSec L4 used). Placement mirrors bootstrap: drop AFTER
# `ct state established,related accept` (an operator who bans their own IP keeps
# the in-flight session) and BEFORE any port accept.
set -euo pipefail

CONF=/etc/nftables.conf

# Nothing to do if this node doesn't use the standard nft ruleset (e.g. a
# firewall mode that never wrote the file). Exit 0 — not an error.
if [[ ! -f "$CONF" ]]; then
  echo "host-migration: $CONF absent — node not on the standard nft firewall; skipping."
  exit 0
fi

# Idempotency guard: no-op only when the migration is FULLY applied — both the
# persistent config AND the live kernel (sets + drop rule). Checking the file
# alone is unsafe: if a prior run wrote $CONF (step 4) but a later live `nft
# add/insert` (step 5) failed, the file would pass this guard while the kernel
# is missing the set/rule → the firewall-reconciler then can't land bans. So we
# re-do the (idempotent) work unless live is also complete.
conf_has_set() { grep -qE '^[[:space:]]*set blacklist_v4 \{' "$CONF"; }
live_complete() {
  nft list set inet filter blacklist_v4 >/dev/null 2>&1 &&
  nft list set inet filter blacklist_v6 >/dev/null 2>&1 &&
  { local c; c="$(nft list chain inet filter input)"; grep -q '@blacklist_v4 drop' <<<"$c" && grep -q '@blacklist_v6 drop' <<<"$c"; }
}
if conf_has_set && live_complete; then
  echo "host-migration: blacklist already complete (config + live) — no-op."
  exit 0
fi

work="$(mktemp)"
trap 'rm -f "$work" "${work}.1"' EXIT

# Persistent-config edit (steps 1-4) only when the config doesn't already
# carry the set — otherwise a prior partial run already edited it and re-
# editing would DUPLICATE the declaration. The live surgical apply (step 5)
# is separately idempotent and always runs to repair an incomplete kernel.
if ! conf_has_set; then
cp "$CONF" "$work"

# 1. Insert the two interval sets immediately before the crowdsec_blocklist_v4
#    set declaration (set order is irrelevant; this is a stable single-line
#    anchor present on every modern cluster). Fall back to inserting before the
#    `chain input {` line if crowdsec sets are absent.
set_block='  set blacklist_v4 {\n    type ipv4_addr\n    flags interval\n  }\n  set blacklist_v6 {\n    type ipv6_addr\n    flags interval\n  }'
if grep -qE '^\s*set crowdsec_blocklist_v4 \{' "$work"; then
  awk -v ins="$set_block" '
    /^[[:space:]]*set crowdsec_blocklist_v4 \{/ && !done_set { print_block(ins); done_set=1 }
    { print }
    function print_block(b,  n,a,i){ n=split(b,a,"\\n"); for(i=1;i<=n;i++) print a[i] }
  ' "$work" > "$work.1" && mv "$work.1" "$work"
elif grep -qE '^\s*chain input \{' "$work"; then
  awk -v ins="$set_block" '
    /^[[:space:]]*chain input \{/ && !done_set { print_block(ins); done_set=1 }
    { print }
    function print_block(b,  n,a,i){ n=split(b,a,"\\n"); for(i=1;i<=n;i++) print a[i] }
  ' "$work" > "$work.1" && mv "$work.1" "$work"
else
  echo "host-migration: no nft set/chain anchor in $CONF — unexpected firewall shape; skipping." >&2
  exit 0
fi

# 2. Insert the two drop rules. Prefer right BEFORE the crowdsec drop (permanent
#    before TTL'd, both already correctly positioned). Else right AFTER
#    `ct state established,related accept` (the escape-hatch boundary).
drop_block='    ip  saddr @blacklist_v4 drop\n    ip6 saddr @blacklist_v6 drop'
if grep -qE '^\s*ip\s+saddr @crowdsec_blocklist_v4 drop' "$work"; then
  awk -v ins="$drop_block" '
    /^[[:space:]]*ip[[:space:]]+saddr @crowdsec_blocklist_v4 drop/ && !done_drop { print_block(ins); done_drop=1 }
    { print }
    function print_block(b,  n,a,i){ n=split(b,a,"\\n"); for(i=1;i<=n;i++) print a[i] }
  ' "$work" > "$work.1" && mv "$work.1" "$work"
elif grep -qE '^\s*ct state established,related accept' "$work"; then
  awk -v ins="$drop_block" '
    { print }
    /^[[:space:]]*ct state established,related accept/ && !done_drop { print_block(ins); done_drop=1 }
    function print_block(b,  n,a,i){ n=split(b,a,"\\n"); for(i=1;i<=n;i++) print a[i] }
  ' "$work" > "$work.1" && mv "$work.1" "$work"
else
  echo "host-migration: no drop-rule anchor (ct established) in $CONF — skipping." >&2
  exit 0
fi

# 3. Validate the rewritten persistent config BEFORE saving it. `nft -c -f`
#    is check-only (no apply), so it never touches the live ruleset.
if ! nft -c -f "$work"; then
  echo "host-migration: rewritten $CONF failed 'nft -c' validation — REFUSING to save." >&2
  exit 1
fi

# 4. Save the persistent config (takes effect on the next boot's
#    `nft -f /etc/nftables.conf`, which is safe because k3s/Calico aren't up
#    yet at that point).
install -m 0644 "$work" "$CONF"
fi  # end persistent-config edit

# 5. Apply to the LIVE ruleset SURGICALLY — `nft add set` + `nft insert rule`,
#    NEVER `nft -f $CONF`. The config begins with `flush ruleset`, which on a
#    running node wipes EVERY nft table — including the CNI portmap hostPort
#    rules and kube-proxy/Calico NAT — breaking ingress until those
#    controllers (or a Traefik restart) rebuild them. Surgical add/insert
#    touches only our two sets + two rules. (This is exactly how the
#    firewall-reconciler and CrowdSec L4 apply — via libnftnl, never a
#    whole-ruleset reload.)
nft list set inet filter blacklist_v4 >/dev/null 2>&1 || nft add set inet filter blacklist_v4 '{ type ipv4_addr ; flags interval ; }'
nft list set inet filter blacklist_v6 >/dev/null 2>&1 || nft add set inet filter blacklist_v6 '{ type ipv6_addr ; flags interval ; }'

live="$(nft -a list chain inet filter input)"
if ! grep -q '@blacklist_v4 drop' <<<"$live"; then
  # Insert BEFORE the crowdsec drop (permanent before TTL'd) — else before
  # the first port-accept (still after `ct established`, before any accept).
  anchor="$(awk '/@crowdsec_blocklist_v4 drop/{print $NF; exit}' <<<"$live")"
  [[ -n "$anchor" ]] || anchor="$(awk '/tcp dport [0-9]+ accept/{print $NF; exit}' <<<"$live")"
  if [[ -z "$anchor" ]]; then
    echo "host-migration: no insert anchor (crowdsec drop / port accept) in live chain — skipping live apply (persisted to $CONF for next boot)." >&2
    exit 0
  fi
  nft insert rule inet filter input handle "$anchor" ip saddr @blacklist_v4 drop
  nft insert rule inet filter input handle "$anchor" ip6 saddr @blacklist_v6 drop
fi

# 6. Confirm. CAPTURE then grep — never `nft list | grep -q` under
#    `set -o pipefail`: grep -q closes the pipe on first match and the still-
#    writing nft gets SIGPIPE, so the pipeline reports nft's failure despite
#    the match (only bites on a large real-cluster ruleset).
live="$(nft list chain inet filter input)"
if grep -q '@blacklist_v4 drop' <<<"$live" && grep -q '@blacklist_v6 drop' <<<"$live"; then
  echo "host-migration: firewall-blacklist nft sets + drop rules backfilled (live + persisted)."
  exit 0
fi
echo "host-migration: persisted to $CONF but blacklist drop not visible in live ruleset after surgical apply." >&2
exit 1
