#!/usr/bin/env bash
# ci-required-env-wired-check.sh — an env var the backend HARD-FAILS without
# must be wired somewhere a real cluster will see it.
#
# WHY: 2026-09-01 an operator created a tenant mailbox on production and tried
# to run a mailbox migration. It returned
#   "STALWART_MASTER_SECRET is required (mail-imapsync routes)"
# `mail-imapsync/routes.ts` read Stalwart's master password from
# `process.env.STALWART_MASTER_SECRET`, and that variable was set in exactly
# ONE file in the whole repository: `k8s/overlays/dind/backend-patch.yaml`,
# as a hardcoded local-dev literal. Base and the development / staging /
# production overlays never set it, so mailbox migration had never worked on
# any real cluster — only in local DinD, and only because of that literal.
# (The helper's `NODE_ENV === 'development'` fallback did NOT cover the DinD
# cluster: the dind overlay sets NODE_ENV=production like every other
# environment. That fallback only ever applied to unit tests and a raw
# `npm run dev`, which is why the gap survived so long — the one place the
# code ran without a real cluster was also the one place it looked fine.)
#
# The failure mode is nasty because it is INVISIBLE until a human drives the
# feature: the code compiles, every unit test passes (they call the pure
# builders directly), and the route only throws at request time. Neither
# typecheck nor the test suite can see that a manifest is missing a key.
#
# So the guard is a manifest-vs-code cross-check: for every env var whose
# absence throws, assert it is provided by something a production cluster
# actually applies. Being present ONLY in the dind overlay is the specific
# bug above and is always a failure.
#
# Exit: 0 clean · 1 a required env var is unwired or dind-only
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
fail=0

# Manifests a real cluster applies. `k8s/overlays/dind` is deliberately absent —
# it is the local-only overlay and is what this guard exists to catch.
REAL_MANIFESTS=(
  k8s/base
  k8s/overlays/development
  k8s/overlays/staging
  k8s/overlays/production
)

# Vars provisioned outside the Kustomize tree. Each entry needs a reason.
#   · DATABASE_URL / JWT_SECRET — written by bootstrap.sh into Secrets that
#     base/backend-deployment.yaml consumes by secretKeyRef; the NAME appears
#     in the manifest, so they are found by the scan below and listed here
#     only as documentation of intent.
# Add to this list ONLY when a var is genuinely supplied by an out-of-tree
# mechanism, and say which one.
declare -A EXEMPT=()

# ── 1. Collect env vars whose absence throws ────────────────────────────────
# Matches the established shape, e.g.
#   throw new Error('PLATFORM_ENCRYPTION_KEY is required (dns-servers routes)');
mapfile -t required < <(
  grep -rhoE "throw new Error\((['\"\`])[A-Z][A-Z0-9_]{3,} is required" \
    backend/src --include="*.ts" 2>/dev/null \
    | grep -oE "[A-Z][A-Z0-9_]{3,}" \
    | sort -u
)

if [ ${#required[@]} -eq 0 ]; then
  echo "ci-required-env-wired: found no 'X is required' throws in backend/src." >&2
  echo "  The extraction pattern probably drifted — a silently-empty guard is" >&2
  echo "  worse than no guard. Fix the pattern rather than deleting this check." >&2
  exit 1
fi

echo "ci-required-env-wired: checking ${#required[@]} required env var(s)…"

# ── 2. Each must appear in a manifest a real cluster applies ────────────────
for var in "${required[@]}"; do
  if [ -n "${EXEMPT[$var]:-}" ]; then
    echo "  · $var — exempt (${EXEMPT[$var]})"
    continue
  fi

  # `name: VAR` is how both a literal `value:` and a `valueFrom:` reference
  # declare the variable on a container.
  real_hits=$(grep -rl "name: $var\$" "${REAL_MANIFESTS[@]}" 2>/dev/null | head -5)
  dind_hits=$(grep -rl "name: $var\$" k8s/overlays/dind 2>/dev/null | head -5)

  if [ -n "$real_hits" ]; then
    echo "  · $var — OK ($(echo "$real_hits" | head -1))"
    continue
  fi

  if [ -n "$dind_hits" ]; then
    echo "ci-required-env-wired: $var is set ONLY in the dind (local-dev) overlay" >&2
    echo "    $(echo "$dind_hits" | head -1)" >&2
    echo "  The backend throws without it, so every non-local cluster fails at" >&2
    echo "  request time. Either wire it into k8s/base (or the real overlays)," >&2
    echo "  or — better — have the consuming workload read the value from the" >&2
    echo "  Secret that already holds it via secretKeyRef, the way" >&2
    echo "  tenant-bundles/components/mailboxes.ts does." >&2
    fail=1
    continue
  fi

  echo "ci-required-env-wired: $var is required by backend/src but set by NO manifest" >&2
  echo "  Searched: ${REAL_MANIFESTS[*]} and k8s/overlays/dind" >&2
  fail=1
done

# ── 3. The specific regression, named ───────────────────────────────────────
# Belt-and-braces: mail-imapsync must never go back to reading the master
# password from platform-api's environment.
if grep -rqE "process\.env\.(STALWART_)?MASTER_SECRET" \
     backend/src/modules/mail-imapsync 2>/dev/null; then
  echo "ci-required-env-wired: mail-imapsync reads the Stalwart master password" >&2
  echo "  from platform-api's environment again. It must come from the mail" >&2
  echo "  namespace's own Secret via secretKeyRef (mail-secrets /" >&2
  echo "  STALWART_MASTER_PASSWORD) so platform-api never handles the cleartext." >&2
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "ci-required-env-wired: OK — every required env var is wired for real clusters."
fi
exit "$fail"
