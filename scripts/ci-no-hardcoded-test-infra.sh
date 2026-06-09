#!/usr/bin/env bash
set -uo pipefail

# ci-no-hardcoded-test-infra.sh — fail CI when a committed integration/utility
# SHELL script bakes in one operator's real infrastructure: a public node IP or
# an operator-owned domain.
#
# Background: the integration harnesses target a live cluster, and their
# connection settings used to default to the maintainer's own cluster
# (SSH_HOST=root@<real-ip>, ADMIN_HOST=admin.staging.<real-domain>, etc.). On a
# PUBLIC repo that leaks the operator's infrastructure AND welds the suite to one
# cluster. The fix moved those values into a gitignored profile
# (scripts/integration.env, template scripts/integration.env.example) loaded by
# scripts/lib/integration-env.sh; committed scripts carry only example.test /
# placeholder defaults. This guard enforces that no real infra slips back in.
#
# Companion to ci-no-pinned-domains.sh, which deliberately scans ONLY the K8s
# manifest tree (*.yaml). This one covers scripts/*.sh, which that guard skips.
#
# Allowed (NOT flagged):
#   - example.test / example.com / *.example  (placeholders)
#   - k8s-platform.test                        (the local DinD dev apex)
#   - RFC 5737 doc IPs: 192.0.2.x 198.51.100.x 203.0.113.x  (test fixtures)
#   - RFC 1918 private, loopback, link-local, RFC 6598 100.64/10, multicast
#   - public resolvers 1.1.1.1 8.8.8.8 9.9.9.9 and obvious fakes 1.2.3.4 5.6.7.8
#   - this guard file itself (it names the forbidden literals by design)

SCAN_DIR="${1:-scripts}"
SELF="$(basename "${BASH_SOURCE[0]}")"
FOUND=0

# ── 1. Operator-owned domains (any occurrence is a leak) ─────────────────────
# Stable identifiers — these must never appear in a committed file.
DOMAIN_PATTERNS=(
  'phoenix-host\.net'
  'phoenix-tech\.net'
  'success\.com\.na'
)
for pat in "${DOMAIN_PATTERNS[@]}"; do
  matches=$(grep -rnE "$pat" "$SCAN_DIR" \
              --include='*.sh' --include='*.md' --exclude="$SELF" --exclude='ci-no-pinned-domains.sh' 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    echo "── operator domain literal '${pat}':"
    echo "$matches" | sed 's|^|        |'
    FOUND=1
  fi
done

# ── 2. Real public IPv4 literals ─────────────────────────────────────────────
# Generic check: flag any IPv4 that is NOT in a reserved/documentation/public-
# infra range. Catches a NEW node IP even if its exact value isn't yet known.
ALLOWED_IP_RE='^(0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.|255\.|1\.1\.1\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9|1\.2\.3\.4|4\.3\.2\.1|5\.6\.7\.8)'
ip_hits=$(grep -rnoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$SCAN_DIR" \
            --include='*.sh' --include='*.md' --exclude="$SELF" --exclude='ci-no-pinned-domains.sh' 2>/dev/null || true)
if [[ -n "$ip_hits" ]]; then
  # each line: path:lineno:IP — keep only IPs outside the allow-list
  bad_ips=$(echo "$ip_hits" | awk -F: -v re="$ALLOWED_IP_RE" '
    { ip=$NF } ip !~ re { print }')
  if [[ -n "$bad_ips" ]]; then
    echo "── non-reserved (likely real) public IPv4 literal(s):"
    echo "$bad_ips" | sed 's|^|        |'
    FOUND=1
  fi
fi

if [[ "$FOUND" -ne 0 ]]; then
  cat >&2 <<'EOF'

❌ ci-no-hardcoded-test-infra: real operator infrastructure found in committed script(s).

  Move cluster coordinates and confidential external-target credentials into the
  gitignored profile scripts/integration.env (template: scripts/integration.env.example),
  loaded by scripts/lib/integration-env.sh. Committed scripts must use example.test /
  placeholder defaults and require_env / require_or_skip for real values.
  See docs/development/INTEGRATION_TESTS.md.
EOF
  exit 1
fi

echo "✅ ci-no-hardcoded-test-infra: no operator IPs or domains in committed scripts."
