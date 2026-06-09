#!/usr/bin/env bash
set -uo pipefail

# ci-no-hardcoded-test-infra.sh — fail CI when a committed file leaks the
# maintainer's real infrastructure: an operator-owned domain or a real public
# node IP. Repo-wide guard.
#
# Background: this is a PUBLIC OSS repo. Agents repeatedly baked one operator's
# cluster (node IPs, apex domain), and even credentials, into committed scripts,
# tests, source comments, and docs — despite an explicit "no private data" rule.
# Nothing ENFORCED it outside the k8s/ manifest tree. This guard does, across the
# whole repo, so the class can't regress.
#
# Companions (scoped, kept for their specific rules):
#   - ci-no-pinned-domains.sh   — k8s/ YAML: forbids hard-coded apex literals
#   - ci-no-hardcoded-ips.sh    — k8s/ YAML: forbids public-IP literals
# Secret material is covered separately by the gitleaks job (.gitleaks.toml).
#
# What it checks (repo-wide, tracked files only):
#   1. OPERATOR IDENTIFIERS — the maintainer's domains AND the bare operator name
#      (phoenix-host / phoenix-tech / phoenix-platform / "Phoenix Tech|Hosting|
#      Platform" / phoenixtechnam) and success.com.na. Zero tolerance, any file
#      class. (The Phoenix/Elixir framework — "phoenix/…" — is NOT matched.)
#   2. PUBLIC IPv4 — (a) the operator's known node netblocks, flagged anywhere;
#      (b) any non-reserved public IP under scripts/ (the SSH-host-default leak
#      vector). Backend/frontend/docs use illustrative IPs legitimately, so the
#      generic check is scoped to scripts/; the domain check stays repo-wide.
#
# Allowed (NOT flagged): example.test / *.example, the k8s-platform.test local-dev
# apex, RFC 5737 doc IPs (192.0.2 / 198.51.100 / 203.0.113), RFC 1918 / loopback /
# link-local / CGNAT, multicast, public resolvers, and obvious fakes (1.2.3.4 …).

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

# Guard files that legitimately contain the forbidden literals (patterns/allowlists).
GUARD_SKIP_RE='^scripts/(ci-no-hardcoded-test-infra|ci-no-pinned-domains|ci-no-hardcoded-ips)\.sh$'
FOUND=0

# Tracked text files (git ls-files respects .gitignore → no node_modules/dist).
mapfile -t ALL < <(git ls-files \
  | grep -vE '\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|lock|bundle|wasm)$' \
  | grep -vE 'package-lock\.json$' \
  | grep -vE "$GUARD_SKIP_RE")

# ── 1. operator identifiers (every file class, case-insensitive) ─────────────
# The bare hyphenated name (phoenix-host) subsumes the domain and its
# regex-escaped form (phoenix-host\.net); the spaced forms catch the brand.
# "phoenix/…" (the Phoenix/Elixir framework) is deliberately NOT matched.
DOMAIN_RE='phoenix-host|phoenix-tech|phoenix-platform|phoenixtech|phoenixnam|phoenix hosting|phoenix platform|success\\?\.com\\?\.na'
dom_hits=$(printf '%s\0' "${ALL[@]}" | xargs -0 -r grep -ainE "$DOMAIN_RE" 2>/dev/null || true)
if [[ -n "$dom_hits" ]]; then
  echo "── operator domain literal(s):"
  echo "$dom_hits" | sed 's|^|        |' | head -40
  FOUND=1
fi

# ── 2a. operator's known public netblocks — flagged ANYWHERE (precise) ───────
# The maintainer's Hetzner/OVH node ranges. Catches a regression of these
# specific IPs (or same-netblock siblings) in any file class, with zero false
# positives. Append a prefix here if the operator provisions a new netblock.
OPERATOR_IP_RE='\b(89\.167|46\.224|167\.235|23\.88|178\.104|51\.89|65\.21|160\.242)\.[0-9]{1,3}\.[0-9]{1,3}\b'
op_hits=$(printf '%s\0' "${ALL[@]}" | xargs -0 -r grep -anoE "$OPERATOR_IP_RE" 2>/dev/null || true)
if [[ -n "$op_hits" ]]; then
  echo "── operator public-IP netblock literal(s):"
  echo "$op_hits" | sed 's|^|        |' | head -40
  FOUND=1
fi

# ── 2b. any non-reserved public IPv4 in scripts/ (the SSH-host-default vector) ─
# Backend/frontend/docs legitimately use illustrative public IPs (1.2.3.4,
# example.com's IP, Cloudflare ranges as trusted-proxy examples), so the generic
# check is scoped to scripts/ — which carries cluster-connection config and is
# kept fixture-free. Test scripts are exempt.
TEST_RE='\.(test|spec)\.[jt]sx?$|_test\.go$|/__tests__/'
ALLOWED_IP_RE='^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.|1\.1\.1\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9|1\.2\.3\.4|4\.3\.2\.1|5\.6\.7\.8|2\.2\.2\.2|3\.3\.3\.3|5\.5\.5\.5)'
mapfile -t SCRIPTIP < <(printf '%s\n' "${ALL[@]}" | grep -E '^scripts/' | grep -vE "$TEST_RE")
ip_hits=$(printf '%s\0' "${SCRIPTIP[@]}" | xargs -0 -r grep -anoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' 2>/dev/null || true)
if [[ -n "$ip_hits" ]]; then
  bad=$(echo "$ip_hits" | awk -F: -v allow="$ALLOWED_IP_RE" '
    { ip=$NF }
    { ok=1; n=split(ip,o,"."); for(i=1;i<=4;i++) if(o[i]+0>255) ok=0 }
    ok && ip !~ allow { print }')
  if [[ -n "$bad" ]]; then
    echo "── non-reserved (likely real) public IPv4 in a script:"
    echo "$bad" | sed 's|^|        |' | head -40
    FOUND=1
  fi
fi

if [[ "$FOUND" -ne 0 ]]; then
  cat >&2 <<'EOF'

❌ ci-no-hardcoded-test-infra: operator domain or real public IP found in a committed file.

  This is a PUBLIC repo. Use example.test / RFC 5737 doc IPs (192.0.2.x,
  198.51.100.x, 203.0.113.x) in committed files. Real cluster coordinates and
  confidential credentials belong in the gitignored scripts/integration.env
  profile (scripts/lib/integration-env.sh). See docs/development/INTEGRATION_TESTS.md.
EOF
  exit 1
fi
echo "✅ ci-no-hardcoded-test-infra: no operator domains or real public IPs in committed files."
