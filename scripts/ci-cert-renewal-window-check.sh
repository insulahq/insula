#!/usr/bin/env bash
#
# ci-cert-renewal-window-check.sh — every cert-manager Certificate the platform
# obtains from an ACME CA renews at a SHARE of its lifetime, never at a fixed
# duration.
#
# Why this guard exists
# ---------------------
# Tenant certificates renewed at `renewBefore: 360h` (15 days left) while the
# panels called a certificate "expiring" at 30 days left, so every healthy
# certificate showed an orange warning for the last 15 days of each cycle.
# And a fixed duration cannot fit the lifetimes CAs are moving to: Let's
# Encrypt's default profile is moving from 90 to 64 and then 45 days, and its
# opt-in profiles already issue 45- and 6-day certificates. `renewBefore: 720h` on a 6-day certificate renews it forever.
#
# The rule (backend/src/modules/certificates/renewal-policy.ts): use
# `renewBeforePercentage`, and the value must be the policy's
# RENEW_BEFORE_PERCENTAGE — the panels' "expiring" threshold is derived from
# it, so a manifest with a different share would warn too early or too late.
#
# Checked: backend code (outside tests), k8s/ manifests (YAML and JSON),
# scripts/ (the local-dev and bootstrap heredocs, Python helpers), host
# migrations and docker-compose files. Any spelling counts: a YAML or object
# key (quoted or not), an assignment, a JSON-patch `/spec/renewBefore` path.
# Comments are ignored — a whole comment line, or the part after `#` / `//`.
#
# Allowed: self-signed internal chains whose lifetime the file itself sets,
# and vendored upstream manifests — listed in ALLOW below with the reason.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

POLICY=backend/src/modules/certificates/renewal-policy.ts
# Files allowed to keep an absolute renewBefore, with why.
ALLOW=(
  # Self-signed CA + serving cert for the ACME DNS webhook; lifetimes are set
  # in the same file (5 years / 1 year), no public CA involved.
  'k8s/base/acme-webhook/certificate.yaml'
  # Vendored upstream CloudNativePG plugin manifest (self-signed, internal).
  'k8s/base/cnpg-system/plugin-barman-cloud-'
)

is_allowed() {
  local f=$1 a
  for a in "${ALLOW[@]}"; do
    [[ "$f" == "$a"* ]] && return 0
  done
  return 1
}

fail=0

pct=$(grep -oE 'export const RENEW_BEFORE_PERCENTAGE = [0-9]+' "$POLICY" | grep -oE '[0-9]+$' || true)
if [ -z "$pct" ]; then
  echo "::error file=$POLICY::RENEW_BEFORE_PERCENTAGE not found — the guard cannot check manifests against the policy"
  exit 1
fi

# 1. Absolute renewBefore anywhere it is not allowed. Strip comment lines
#    first (`#` in YAML/shell, `//` and ` *` in TypeScript).
# `renewBefore` (key quoted or not) set with `:` or `=` to a duration literal
# such as 720h / "360h" / '8760h', or a JSON-patch path ending in it. Reading
# the field (`spec.renewBefore as string`) or nulling it out to migrate an
# object is not a schedule, and does not match.
FIELD_RE='(renewBefore["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'`]?[0-9])|(/renewBefore(["'"'"'[:space:]]|$))'
PATHS=(
  'backend/src/*.ts' 'backend/src/*.js'
  'k8s/*.yaml' 'k8s/*.yml' 'k8s/*.json'
  'scripts/*.sh' 'scripts/*.py' 'scripts/*.yaml' 'scripts/*.yml'
  'platform/*.sh' 'platform/*.yaml'
  'docker-compose*.yml' 'docker-compose*.yaml'
)
while IFS=: read -r file line text; do
  [ -z "$file" ] && continue
  case "$file" in *.test.ts|*.spec.ts) continue ;; esac
  is_allowed "$file" && continue
  trimmed=${text#"${text%%[![:space:]]*}"}
  case "$trimmed" in '#'*|'//'*|'*'*) continue ;; esac
  # Only the code before a trailing comment counts.
  code=${text%%#*}
  code=${code%%//*}
  [[ "$code" =~ $FIELD_RE ]] || continue
  echo "::error file=$file,line=$line::absolute renewBefore — use renewBeforePercentage: $pct (see $POLICY)"
  fail=1
done < <(git grep -nE "$FIELD_RE" -- "${PATHS[@]}" || true)

# 2. Every literal renewBeforePercentage in manifests/scripts matches the policy.
while IFS=: read -r file line text; do
  [ -z "$file" ] && continue
  is_allowed "$file" && continue
  value=$(echo "$text" | grep -oE 'renewBeforePercentage["'"'"']?[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' || true)
  [ -z "$value" ] && continue
  if [ "$value" != "$pct" ]; then
    echo "::error file=$file,line=$line::renewBeforePercentage $value differs from the policy's $pct ($POLICY)"
    fail=1
  fi
done < <(git grep -nE 'renewBeforePercentage["'"'"']?[[:space:]]*:[[:space:]]*[0-9]+' -- "${PATHS[@]}" || true)

if [ "$fail" -ne 0 ]; then
  echo "cert-renewal-window: FAILED"
  exit 1
fi
echo "cert-renewal-window: every ACME Certificate renews at ${pct}% of its lifetime — OK"
