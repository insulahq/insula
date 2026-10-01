#!/usr/bin/env bash
# ci-host-migration-bootstrap-parity.sh — every HOST path a host-migration may
# write (its `# allow-paths:` header) must also be written by bootstrap.sh (or
# its lib/), because a freshly bootstrapped node records every shipped
# migration as a BASELINE instead of running it (`insula host-config baseline`).
# A migration whose host change bootstrap does not make would therefore never
# reach a fresh node — the Traefik access-log rotation was exactly that: a
# fresh node would have had no rotation and an unbounded log.
#
# Cluster-only migrations (allow-paths: none) are out of scope: cluster state
# is created by the first server, not per node.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0; n=0
for f in "$ROOT"/platform/host-migrations/*/*.sh; do
  ap="$(grep -m1 '^# allow-paths:' "$f" | sed 's/^# allow-paths:[[:space:]]*//')"
  paths="$(grep -oE '/(etc|usr|var|opt)/[A-Za-z0-9_./-]+' <<<"$ap" | sort -u || true)"
  [[ -n "$paths" ]] || continue
  for p in $paths; do
    n=$((n + 1))
    if ! grep -qF -- "$p" "$ROOT/scripts/bootstrap.sh" "$ROOT"/scripts/lib/*.sh \
       && ! grep -qF -- "$(basename "$p")" "$ROOT/scripts/bootstrap.sh" "$ROOT"/scripts/lib/*.sh; then
      echo "::error::${f#"$ROOT"/}: bootstrap.sh never writes ${p} — a fresh (baselined) node would never get this change. Make bootstrap produce it too."
      fail=1
    fi
  done
done
[[ "$fail" -eq 0 ]] && echo "ci-host-migration-bootstrap-parity: ${n} host path(s) covered by bootstrap — OK."
exit "$fail"
