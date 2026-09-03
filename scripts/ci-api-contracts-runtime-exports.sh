#!/usr/bin/env bash
# ci-api-contracts-runtime-exports.sh — assert the BUILT api-contracts package
# actually exports what consumers import at RUNTIME.
#
# WHY: the panels' vitest now aliases @insula/api-contracts to source, which
# removed the last place in CI that imported the compiled dist and would throw
# "<symbol> is not a function". Type-checking cannot cover this: a dist whose
# .d.ts and .js disagree (partial emit, a build that refreshed types but not one
# output file) typechecks clean, usually bundles clean, and fails only in a
# browser. That is exactly how `dnsRecordFieldsFor is not a function` reached a
# developer on 2026-08-20 while CI stayed green.
#
# This imports dist/index.js for real and checks a list of load-bearing runtime
# symbols — the value-exports consumers call. Types are NOT checked here; tsc
# already covers those.
set -uo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
DIST="$ROOT/packages/api-contracts/dist/index.js"

if [ ! -f "$DIST" ]; then
  echo "::error::ci-api-contracts-runtime-exports: $DIST missing — build with 'tsc --build --force' first." >&2
  exit 1
fi

# Value exports (functions/consts) that panels or the backend call at runtime.
# Add to this list when a new one becomes load-bearing; a symbol here that
# vanishes from the build is a release-blocking regression, not a lint nit.
REQUIRED_EXPORTS="${API_CONTRACTS_REQUIRED_EXPORTS:-dnsRecordFieldsFor MAX_PAGE_LIMIT MAX_DNS_RESOLVER_SERVERS isBareIpAddress partitionByFamily NOTIFICATION_CHANNEL_ID isNotificationChannelId}"

REQ="$REQUIRED_EXPORTS" DIST="$DIST" node --input-type=module -e "
const required = process.env.REQ.split(' ').filter(Boolean);
const m = await import(process.env.DIST);
const missing = required.filter((k) => m[k] === undefined);
if (missing.length) {
  console.error('::error::ci-api-contracts-runtime-exports: dist/index.js does not export: ' + missing.join(', '));
  console.error('  The .d.ts may still declare them — that is the point. Rebuild with: tsc --build --force');
  process.exit(1);
}
console.log('ci-api-contracts-runtime-exports: OK — ' + required.length + ' runtime export(s) present in dist.');
" 2>&1
rc=$?
exit $rc
