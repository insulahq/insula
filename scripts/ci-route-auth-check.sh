#!/usr/bin/env bash
#
# Guard: a route module that gates on requireRole must also install authenticate.
#
# `requireRole` reads `req.user`, which only exists after `authenticate` has run.
# A module that registers requireRole without it does not fail loudly — every
# request returns 403 INSUFFICIENT_PERMISSIONS, including one from a genuine
# super_admin, so the symptom reads as a permissions problem rather than a wiring
# one. The feature is simply unreachable.
#
# Shipped that way in #588 (pod-prune) and caught only by driving the real
# endpoint on DEV: the JWT said super_admin, the users row said super_admin, and
# every call still 403'd. Unit tests could not catch it — they mock the hooks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

problems=0
checked=0

while IFS= read -r f; do
  grep -q "requireRole" "$f" || continue
  checked=$((checked + 1))
  # The codebase runs authenticate in at least three shapes — a plugin-scoped
  # addHook, an inline per-route array, and a hoisted `const adminGate =
  # [authenticate, requireRole(...)]`. Matching those individually produced six
  # false positives on the first attempt, so the test is simply: does the module
  # USE authenticate anywhere outside its import line? A module that does not
  # reference it at all cannot be running it, which is the failure that shipped.
  if [ "$(grep -c '\bauthenticate\b' <(grep -v '^import' "$f"))" -gt 0 ]; then
    continue
  fi
  echo "  ✗ $f uses requireRole but never runs authenticate."
  echo "    requireRole reads req.user, which authenticate populates. Without it"
  echo "    every request 403s — including a valid super_admin's."
  problems=$((problems + 1))
done < <(find backend/src/modules -name 'routes*.ts' -not -name '*.test.ts' | sort)

if [ "$checked" -eq 0 ]; then
  echo "ci-route-auth-check: found no route module using requireRole — check the glob"
  exit 1
fi

if [ "$problems" -gt 0 ]; then
  echo
  echo "ci-route-auth-check FAILED — $problems module(s)"
  exit 1
fi

echo "ci-route-auth-check: OK ($checked route module(s) gate on requireRole and all run authenticate)"
