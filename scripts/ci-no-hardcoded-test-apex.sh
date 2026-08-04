#!/usr/bin/env bash
# ci-no-hardcoded-test-apex.sh — a harness default must DERIVE the test apex,
# never bake one in.
#
# THE BUG THIS PREVENTS
#   Harnesses spelled the fallback apex inline:
#       local mail_domain_apex="${MAIL_DOMAIN_APEX:-staging.example.test}"
#       ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
#   Some sites derived from the configured apex first, some did not — three
#   non-deriving lines sat in ONE file next to two correct ones. A suite like
#   that can only pass on the apex whose name happens to be baked in. Running
#   the suite against a freshly bootstrapped cluster on 2026-08-04 produced
#       "banner 'mail.<cluster apex>' DOES NOT MATCH expected
#        'mail.staging.example.test'"
#   while mail was in fact healthy — 113 literals across 51 files. Every
#   previous round fixed the line that failed that day instead of the class,
#   so it kept coming back.
#
# THE RULE
#   `staging.example.test` may appear in comments and docs freely. It may NOT
#   appear as the fallback of a shell default expansion (`${VAR:-…}` / `:-`).
#   Derive instead:
#       source .../lib/integration-env.sh
#       X="${X:-$(resolve_platform_apex)}"
#   resolve_platform_apex() in scripts/lib/integration-env.sh is the ONE place
#   the literal is written down; it honours MAIL_DOMAIN_APEX / PLATFORM_DOMAIN
#   / PLATFORM_BASE_DOMAIN / HTTPS_TEST_DOMAIN_BASE / TENANT_BASE.
#
# Note this is about PORTABILITY, not secrecy: `staging.example.test` is the
# sanitised placeholder. Real operator domains are a separate, zero-tolerance
# concern enforced by ci-no-hardcoded-test-infra.sh.
#
# Exit: 0 clean · 1 violations found
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

APEX_LITERAL='staging\.example\.test'
# The resolver itself is the single sanctioned home for the literal.
EXEMPT='scripts/lib/integration-env.sh'

violations=0
report=""

# Only tracked shell scripts — an operator's gitignored profile is theirs.
while IFS= read -r f; do
  [[ "$f" == "$EXEMPT" ]] && continue
  # A violation is the literal appearing as a default-expansion fallback.
  # `:-` is the marker; a leading `#` (comment) is not scanned.
  while IFS= read -r hit; do
    line_no="${hit%%:*}"
    text="${hit#*:}"
    # Skip comment lines — documenting the old shape is fine.
    [[ "$(printf '%s' "$text" | sed 's/^[[:space:]]*//')" == \#* ]] && continue
    report+="  $f:$line_no: $(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-100)"$'\n'
    violations=$((violations + 1))
  done < <(grep -nE ":-[^}]*${APEX_LITERAL}" "$f" 2>/dev/null || true)
done < <(git ls-files '*.sh' 2>/dev/null)

# ─── Check 2: API_BASE must derive from the configured target ────────────
#
# Operator profiles set ADMIN_HOST / API_URL — never API_BASE. A harness that
# defaults API_BASE straight to the local-dev apex therefore points every
# request at localhost when run against a remote cluster, and every assertion
# comes back 000. That is not a visible "wrong host" error; it reads as the
# platform being broken (2026-08-04: node-terminal reported "A1 expected
# super_admin, got ''", webmail-platform failed outright).
while IFS= read -r f; do
  while IFS= read -r hit; do
    line_no="${hit%%:*}"
    text="${hit#*:}"
    [[ "$(printf '%s' "$text" | sed 's/^[[:space:]]*//')" == \#* ]] && continue
    # Deriving forms mention another ${VAR} inside the default — allow those.
    printf '%s' "$text" | grep -qE 'API_BASE:-\$\{' && continue
    report+="  $f:$line_no: $(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-100)"$'\n'
    violations=$((violations + 1))
  done < <(grep -nE '^[[:space:]]*API_BASE="?\$\{API_BASE:-' "$f" 2>/dev/null || true)
done < <(git ls-files 'scripts/integration-*.sh' 'scripts/ingress-*.sh' 2>/dev/null)

if (( violations > 0 )); then
  echo "❌ ci-no-hardcoded-test-apex: $violations hardcoded test-apex default(s):" >&2
  printf '%s' "$report" >&2
  cat >&2 <<'EOF'

  A harness default must derive the apex, not bake one in — otherwise the suite
  only passes on one cluster and fails everywhere else with a confusing
  "expected mail.staging.example.test" style mismatch.

  Fix:
    source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
    X="${X:-$(resolve_platform_apex)}"          # bare apex
    ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
    ADMIN_EMAIL="${ADMIN_EMAIL:-admin@$(resolve_platform_apex)}"
EOF
  exit 1
fi

echo "✅ ci-no-hardcoded-test-apex: every harness default derives the test apex."
