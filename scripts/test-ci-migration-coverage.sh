#!/usr/bin/env bash
# TDD harness for scripts/ci-migration-coverage.sh (Tier 1 forcing function).
# Run: ./scripts/test-ci-migration-coverage.sh   (exit 0 = all pass)
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
GUARD="$REPO_ROOT/scripts/ci-migration-coverage.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

# A fake bootstrap.sh with a known firewall shape ($1 = extra rule line, '' for base).
fake_bootstrap() {
  local extra="${1:-}"
  cat <<EOF
#!/usr/bin/env bash
set_decls="
  set blacklist_v4 {
    type ipv4_addr
    flags interval
  }
"
cat > /etc/nftables.conf <<NFT
table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;
    ip  saddr @blacklist_v4 drop
    tcp dport 80 accept
    tcp dport 443 accept
    ${extra}
  }
}
NFT
EOF
}

# Run the guard with a fixture bootstrap + baseline + injected signals.
# Args: <bootstrap-file> <baseline-file> <MIGRATION_ADDED> <WAIVER> <BASELINE_UPDATED>
run() {
  FWSHAPE_BOOTSTRAP="$1" FWSHAPE_BASELINE="$2" \
  MIGRATION_ADDED="$3" WAIVER="$4" BASELINE_UPDATED="$5" \
  bash "$GUARD" >/dev/null 2>&1
}
expect() { # <desc> <expected-rc> <actual-rc>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want rc=$2 got rc=$3)"; fi
}

D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
fake_bootstrap "" > "$D/bootstrap.sh"
# baseline = current shape of the unchanged bootstrap
FWSHAPE_BOOTSTRAP="$D/bootstrap.sh" FWSHAPE_BASELINE="$D/baseline" bash "$GUARD" --update-baseline >/dev/null

echo "== shape unchanged → always OK (signals irrelevant) =="
run "$D/bootstrap.sh" "$D/baseline" 0 0 0; expect "unchanged passes" 0 $?

echo "== shape CHANGED → coverage required =="
fake_bootstrap "tcp dport 9999 accept" > "$D/changed.sh"
run "$D/changed.sh" "$D/baseline" 0 0 0; expect "changed + nothing → FAIL" 1 $?
run "$D/changed.sh" "$D/baseline" 1 0 0; expect "changed + migration but baseline NOT refreshed → FAIL" 1 $?
run "$D/changed.sh" "$D/baseline" 0 0 1; expect "changed + baseline refreshed but NO migration → FAIL" 1 $?
run "$D/changed.sh" "$D/baseline" 1 0 1; expect "changed + migration + baseline refreshed → OK" 0 $?
run "$D/changed.sh" "$D/baseline" 0 1 1; expect "changed + waiver + baseline refreshed → OK" 0 $?
run "$D/changed.sh" "$D/baseline" 0 1 0; expect "changed + waiver but baseline NOT refreshed → FAIL" 1 $?

echo "== waiver must START a commit-message line — prose mention does NOT waive (git-derived) =="
# Exercises the real git-log waiver grep (not the WAIVER env override): a
# mid-sentence prose/markdown mention of the token must not count, only a line
# that begins with it. Regression for the v2026.6.4 false "1 waiver" match.
G=$(mktemp -d)
git -C "$G" init -q
git -C "$G" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "base"
WBASE=$(git -C "$G" rev-parse HEAD)
git -C "$G" -c user.email=t@t -c user.name=t commit -q --allow-empty \
  -m "fix: document the [no-host-migration] token inline (prose, mid-line)"
BASE_REF="$WBASE" REPO_ROOT="$G" FWSHAPE_BOOTSTRAP="$D/changed.sh" FWSHAPE_BASELINE="$D/baseline" \
  MIGRATION_ADDED=0 BASELINE_UPDATED=1 bash "$GUARD" >/dev/null 2>&1
expect "prose mention of token does NOT waive → FAIL" 1 $?
git -C "$G" -c user.email=t@t -c user.name=t commit -q --allow-empty \
  -m "$(printf 'fix: open port 9999\n\n[no-host-migration] only fresh installs need this rule')"
BASE_REF="$WBASE" REPO_ROOT="$G" FWSHAPE_BOOTSTRAP="$D/changed.sh" FWSHAPE_BASELINE="$D/baseline" \
  MIGRATION_ADDED=0 BASELINE_UPDATED=1 bash "$GUARD" >/dev/null 2>&1
expect "line-anchored waiver → OK" 0 $?
rm -rf "$G"

echo "== removing a drop RULE is detected (HIGH: pattern must match @set_v4) =="
fake_bootstrap "" | sed '/ip  saddr @blacklist_v4 drop/d' > "$D/nodrop.sh"
run "$D/nodrop.sh" "$D/baseline" 0 0 0; expect "drop rule removed + no coverage → FAIL" 1 $?

echo "== whitespace / comment edits do NOT count as a shape change =="
fake_bootstrap "" | sed 's/    tcp dport 80 accept/        tcp dport 80 accept    # reindented + comment/' > "$D/cosmetic.sh"
run "$D/cosmetic.sh" "$D/baseline" 0 0 0; expect "reindent+comment → still OK" 0 $?

echo "== infra version PIN change → coverage required (external-snapshotter v6→v8 gap, 2026-06-30) =="
# A bootstrap-pinned infra version is rendered ONCE at install, so a bump needs a
# host-migration to reach existing nodes — same gate as the firewall shape.
printf '#!/usr/bin/env bash\nLONGHORN_VERSION="v1.11.1"\n' > "$D/pin.sh"
FWSHAPE_BOOTSTRAP="$D/pin.sh" FWSHAPE_BASELINE="$D/pinbase" bash "$GUARD" --update-baseline >/dev/null
run "$D/pin.sh"  "$D/pinbase" 0 0 0; expect "pin unchanged → OK" 0 $?
printf '#!/usr/bin/env bash\nLONGHORN_VERSION="v1.12.0"\n' > "$D/pin2.sh"
run "$D/pin2.sh" "$D/pinbase" 0 0 0; expect "pin bumped + no coverage → FAIL" 1 $?
run "$D/pin2.sh" "$D/pinbase" 1 0 1; expect "pin bumped + migration + baseline → OK" 0 $?
# A local `snap_ver="vX"` assignment (external-snapshotter) is fingerprinted too.
printf '#!/usr/bin/env bash\n  local snap_ver="v6.3.0"\n' > "$D/snap.sh"
FWSHAPE_BOOTSTRAP="$D/snap.sh" FWSHAPE_BASELINE="$D/snapbase" bash "$GUARD" --update-baseline >/dev/null
printf '#!/usr/bin/env bash\n  local snap_ver="v8.6.0"\n' > "$D/snap2.sh"
run "$D/snap2.sh" "$D/snapbase" 0 0 0; expect "snap_ver bumped + no coverage → FAIL" 1 $?
# An arg-parser assignment from a variable must NOT be fingerprinted (no churn).
printf '#!/usr/bin/env bash\nLONGHORN_VERSION="v1.11.1"\n--longhorn-version) LONGHORN_VERSION="$2";;\n' > "$D/argp.sh"
FWSHAPE_BOOTSTRAP="$D/argp.sh" FWSHAPE_BASELINE="$D/argpbase" bash "$GUARD" --update-baseline >/dev/null
printf '#!/usr/bin/env bash\nLONGHORN_VERSION="v1.11.1"\n--longhorn-version) LONGHORN_VERSION="$3";;\n' > "$D/argp2.sh"
run "$D/argp2.sh" "$D/argpbase" 0 0 0; expect "arg-parser var assignment edit → still OK (not fingerprinted)" 0 $?
# A pin-line trailing-comment edit is NOT a change.
printf '#!/usr/bin/env bash\nLONGHORN_VERSION="v1.11.1"   # 2026-07-01 reviewed\n' > "$D/pin3.sh"
run "$D/pin3.sh" "$D/pinbase" 0 0 0; expect "pin comment edit → still OK" 0 $?

echo "== install-time systemd UNITS are fingerprinted (2026-08-20) =="
# bootstrap writes each unit ONCE, so a unit edit reaches fresh installs only —
# the gap that let the v2026.8.7 converge trigger nearly ship fresh-install-only.
# $1 = extra [Service] directive ('' for base), $2 = trailing comment text.
fake_lib() {
  local extra="${1:-}" cmt="${2:-baseline}"
  mkdir -p "$D/lib"
  cat > "$D/lib/bootstrap-phases.sh" <<LIBEOF
#!/usr/bin/env bash
install_timer() {
  cat > "\${dir}/platform-ops-update.service" <<UNIT
[Unit]
Description=Insula platform-ops self-upgrade check
# ${cmt}

[Service]
Type=oneshot
ExecStart=\${bin} self-upgrade --check
${extra}
UNIT
  cat > "\${dir}/platform-ops-update.timer" <<'UNIT'
[Timer]
OnCalendar=daily
UNIT
  cat > "\${dir}/platform-ops-host-config.service" <<UNIT
[Service]
Type=oneshot
ExecStart=\${bin} host-config apply
UNIT
  cat > "\${dir}/platform-ops-host-config.timer" <<'UNIT'
[Timer]
OnCalendar=hourly
UNIT
}
LIBEOF
}
# Run with a fixture lib dir as well as a fixture bootstrap.
run_lib() { # <bootstrap> <baseline> <libdir> <MIGRATION_ADDED> <WAIVER> <BASELINE_UPDATED>
  FWSHAPE_BOOTSTRAP="$1" FWSHAPE_BASELINE="$2" FWSHAPE_LIB_DIR="$3" \
  MIGRATION_ADDED="$4" WAIVER="$5" BASELINE_UPDATED="$6" \
  bash "$GUARD" >/dev/null 2>&1
}
fake_lib "" "baseline"
FWSHAPE_BOOTSTRAP="$D/bootstrap.sh" FWSHAPE_BASELINE="$D/unitbase" FWSHAPE_LIB_DIR="$D/lib" \
  bash "$GUARD" --update-baseline >/dev/null
run_lib "$D/bootstrap.sh" "$D/unitbase" "$D/lib" 0 0 0
expect "units unchanged → OK" 0 $?

# THE regression: adding a directive to a unit must demand a host-migration.
fake_lib "ExecStartPost=-/usr/bin/systemctl start --no-block platform-ops-host-config.service" "baseline"
run_lib "$D/bootstrap.sh" "$D/unitbase" "$D/lib" 0 0 0
expect "unit directive added + no coverage → FAIL" 1 $?
run_lib "$D/bootstrap.sh" "$D/unitbase" "$D/lib" 1 0 1
expect "unit directive added + migration + baseline → OK" 0 $?

# A comment-only edit inside a unit must NOT churn the hash (else waiver fatigue).
fake_lib "" "reworded explanatory comment"
run_lib "$D/bootstrap.sh" "$D/unitbase" "$D/lib" 0 0 0
expect "unit comment edit → still OK" 0 $?

# Moving a unit to a different path IS a change (destination is fingerprinted).
fake_lib "" "baseline"
sed -i 's|\${dir}/platform-ops-update.service|${dir}/renamed-update.service|' "$D/lib/bootstrap-phases.sh"
run_lib "$D/bootstrap.sh" "$D/unitbase" "$D/lib" 0 0 0
expect "unit moved to a new path → FAIL" 1 $?

echo "== anti-vacuity: a fingerprint that matched nothing must FAIL, never pass =="
mkdir -p "$D/emptylib"
run_lib "$D/bootstrap.sh" "$D/unitbase" "$D/emptylib" 1 0 1
expect "no units extracted → hard FAIL (not a silent pass)" 1 $?
# --update-baseline must not be able to freeze a broken extraction as correct.
FWSHAPE_BOOTSTRAP="$D/bootstrap.sh" FWSHAPE_BASELINE="$D/vac" FWSHAPE_LIB_DIR="$D/emptylib" \
  bash "$GUARD" --update-baseline >/dev/null 2>&1
expect "--update-baseline refuses a vacuous shape" 1 $?
# A required unit disappearing (extraction silently lost it) must FAIL too.
fake_lib "" "baseline"
sed -i '/platform-ops-host-config.timer/,+3d' "$D/lib/bootstrap-phases.sh"
run_lib "$D/bootstrap.sh" "$D/unitbase" "$D/lib" 1 0 1
expect "required unit missing → hard FAIL" 1 $?

echo "== helm --set flags and values-file heredocs are fingerprinted (2026-08-20) =="
# bootstrap installs Traefik/cert-manager/Longhorn/CNPG ONCE, so a --set change
# is as fresh-install-only as a pin bump. Until v2026.8.8 nothing hashed it.
fake_helm() {  # $1 = extra --set line, $2 = values-heredoc body line
  local extra="${1:-}" vline="${2:-replicas: 1}"
  cat > "$D/helm.sh" <<HELMEOF
#!/usr/bin/env bash
install_traefik() {
  cat > "\$vals" <<'TRAEFIKVALUES'
deployment:
  ${vline}
TRAEFIKVALUES
  helm_cmd upgrade --install traefik traefik/traefik \\
    --namespace traefik \\
    -f "\${vals}" \\
    --set deployment.kind=DaemonSet \\
    ${extra}
    --set service.spec.type=ClusterIP
}
HELMEOF
}
fake_helm "" "replicas: 1"
FWSHAPE_BOOTSTRAP="$D/helm.sh" FWSHAPE_BASELINE="$D/helmbase" FWSHAPE_REQUIRED_HELM_RELEASES=traefik \
  bash "$GUARD" --update-baseline >/dev/null 2>&1
run_helm() { FWSHAPE_BOOTSTRAP="$D/helm.sh" FWSHAPE_BASELINE="$D/helmbase" \
  FWSHAPE_REQUIRED_HELM_RELEASES=traefik MIGRATION_ADDED="$1" WAIVER=0 BASELINE_UPDATED="$2" \
  bash "$GUARD" >/dev/null 2>&1; }

run_helm 0 0; expect "helm values unchanged → OK" 0 $?

# THE regression: a new --set must demand a host-migration.
fake_helm "--set experimental.plugins.crowdsec.version=v1.7.0 \\" "replicas: 1"
run_helm 0 0; expect "new --set flag + no coverage → FAIL" 1 $?
run_helm 1 1; expect "new --set flag + migration + baseline → OK" 0 $?

# A values FILE hides its content from a flag scan — the heredoc body must count.
fake_helm "" "replicas: 3"
run_helm 0 0; expect "values-heredoc body change → FAIL" 1 $?

echo "== a --set hidden behind a pre-block VARIABLE is still fingerprinted =="
# Real bypass found by review 2026-08-20: bootstrap assigned
#   dual_stack_svc_args="--set service.ipFamilyPolicy=PreferDualStack"
# BEFORE the helm call and referenced it as a bare ${dual_stack_svc_args}, so
# neither line carried literal --set text inside the block. A block-scoped scan
# missed a real fresh-install-only value.
cat > "$D/varhelm.sh" <<'VARHELM'
#!/usr/bin/env bash
install_thing() {
  local extra_args=""
  if [ "$X" = "true" ]; then
    extra_args="--set service.ipFamilyPolicy=PreferDualStack"
  fi
  helm_cmd upgrade --install traefik traefik/traefik \
    --namespace traefik \
    ${extra_args} \
    --set deployment.kind=DaemonSet
}
VARHELM
FWSHAPE_BOOTSTRAP="$D/varhelm.sh" FWSHAPE_BASELINE="$D/varbase" FWSHAPE_REQUIRED_HELM_RELEASES=traefik \
  bash "$GUARD" --update-baseline >/dev/null 2>&1
got=$(FWSHAPE_BOOTSTRAP="$D/varhelm.sh" FWSHAPE_REQUIRED_HELM_RELEASES=traefik bash "$GUARD" --print 2>/dev/null | grep -c "ipFamilyPolicy")
[ "$got" -ge 1 ] && ok "variable-assigned --set is captured" || bad "variable-assigned --set is captured (got $got)"

# ...and changing that variable's value must demand coverage.
sed -i 's/PreferDualStack/RequireDualStack/' "$D/varhelm.sh"
FWSHAPE_BOOTSTRAP="$D/varhelm.sh" FWSHAPE_BASELINE="$D/varbase" FWSHAPE_REQUIRED_HELM_RELEASES=traefik \
  MIGRATION_ADDED=0 WAIVER=0 BASELINE_UPDATED=0 bash "$GUARD" >/dev/null 2>&1
expect "changing a variable-assigned --set → FAIL" 1 $?

echo "== --set on the helm_cmd line itself must not drop -f/--version =="
# Rule-ordering regression found by review 2026-08-20: when a line matched both
# the file-wide --set rule and the helm_cmd rule, the --set rule printed and
# `next`ed before inblk was set, so every continuation of that block vanished
# from the fingerprint while the release name still appeared — so the
# anti-vacuity canary passed too. Silent coverage loss, which is the exact
# thing this guard exists to prevent.
cat > "$D/oneline.sh" <<'ONELINE'
#!/usr/bin/env bash
install_x() {
  helm_cmd upgrade --install cnpg cnpg/cloudnative-pg --set foo=bar \
    -f values.yaml \
    --values other.yaml \
    --version 1.2.3
}
ONELINE
shape=$(FWSHAPE_BOOTSTRAP="$D/oneline.sh" FWSHAPE_REQUIRED_HELM_RELEASES=cnpg bash "$GUARD" --print 2>/dev/null)
printf '%s' "$shape" | grep -q -- "-f values.yaml"      && ok "-f survives a one-line helm_cmd --set"      || bad "-f survives a one-line helm_cmd --set"
printf '%s' "$shape" | grep -q -- "--values other.yaml" && ok "--values (long form) is captured"           || bad "--values (long form) is captured"
printf '%s' "$shape" | grep -q -- "--version 1.2.3"     && ok "--version survives a one-line helm_cmd --set" || bad "--version survives"

echo "== anti-vacuity: a helm fingerprint that matched nothing must FAIL =="
printf '#!/usr/bin/env bash\necho no helm here\n' > "$D/nohelm.sh"
FWSHAPE_BOOTSTRAP="$D/nohelm.sh" FWSHAPE_BASELINE="$D/helmbase" FWSHAPE_REQUIRED_HELM_RELEASES=traefik \
  MIGRATION_ADDED=1 BASELINE_UPDATED=1 bash "$GUARD" >/dev/null 2>&1
expect "no helm blocks → hard FAIL (not a silent pass)" 1 $?
FWSHAPE_BOOTSTRAP="$D/nohelm.sh" FWSHAPE_BASELINE="$D/vac2" FWSHAPE_REQUIRED_HELM_RELEASES=traefik \
  bash "$GUARD" --update-baseline >/dev/null 2>&1
expect "--update-baseline refuses a vacuous helm shape" 1 $?
# A values file renamed out of the *VALUES convention must fail loudly.
fake_helm "" "replicas: 1"
sed -i 's/TRAEFIKVALUES/TRAEFIKCONF/g' "$D/helm.sh"
FWSHAPE_BOOTSTRAP="$D/helm.sh" FWSHAPE_BASELINE="$D/helmbase" FWSHAPE_REQUIRED_HELM_RELEASES=traefik \
  MIGRATION_ADDED=1 BASELINE_UPDATED=1 bash "$GUARD" >/dev/null 2>&1
rc=$?
# still passes the canary (traefik is present via the invocation line) but the
# body is no longer hashed — assert the body really did drop out of the shape.
body=$(FWSHAPE_BOOTSTRAP="$D/helm.sh" FWSHAPE_REQUIRED_HELM_RELEASES=traefik bash "$GUARD" --print 2>/dev/null | grep -c "^helmvalues|")
[ "$body" = "0" ] && ok "non-*VALUES heredoc is NOT silently hashed" || bad "non-*VALUES heredoc leaked into shape ($body lines)"

echo "== real repo passes its own committed baseline =="
bash "$GUARD" >/dev/null 2>&1; expect "live repo OK" 0 $?

echo
echo "RESULT: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
