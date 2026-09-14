#!/usr/bin/env bash
# ci-route-body-validation-check.sh — stop the unvalidated-request-body class
# from growing back (ROADMAP R29a).
#
# ## What it guards
#
# A route that does `request.body as unknown as X` and reads fields off the
# result does not reject a wrong body. It reads the misspelled field as
# `undefined`, skips whatever that field controlled, and answers **200**. Two
# shipped bugs came from exactly this: `PATCH /admin/nodes/:name/storage/:diskKey`
# returned 200 while changing nothing, and the OIDC provider PATCH appeared to
# rotate a client id it never wrote.
#
# 19 of the 43 known sites were converted to `parseBody(schema, request.body)`.
# The remaining 24 were each read and classified (see the allowlist header):
# non-JSON bodies, handlers that already reject what they cannot use, and bodies
# validated by the service that consumes them. This guard freezes that set.
#
# ## Why an allowlist of FILES, not a count
#
# A count passes whenever one cast is removed and another added — the two cancel,
# and the guard reports success through the exact change it exists to catch. A
# line-numbered list churns on every edit above a cast and gets "fixed" by
# regenerating it, which quietly relicenses whatever was added. The file is the
# stable unit: a cast appearing in a file that had none is a new decision, and
# that is what needs a human.
#
# Removing an entry is the goal. Adding one needs a reason in the PR.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
ALLOWLIST="$REPO_ROOT/scripts/.route-body-cast-allowlist.txt"
MODULES="$REPO_ROOT/backend/src/modules"

fail() {
  echo "ci-route-body-validation-check: FAIL — $1" >&2
  exit 1
}

[[ -f "$ALLOWLIST" ]] || fail "$ALLOWLIST not found"
[[ -d "$MODULES" ]] || fail "$MODULES not found"

# Strip comments and blanks. Sorted for comm(1).
allowed=$(grep -vE '^\s*(#|$)' "$ALLOWLIST" | sort -u)

# Route files only — a `request.body as` in a *.test.ts is a fixture, not an
# endpoint, and sweeping tests in would make the guard fail on its own coverage.
actual=$(cd "$MODULES" && grep -rl 'request\.body as' --include='routes.ts' --include='routes-*.ts' . 2>/dev/null \
  | sed 's|^\./||' | sort -u || true)

new=$(comm -13 <(echo "$allowed") <(echo "$actual") || true)
if [[ -n "$new" ]]; then
  echo "ci-route-body-validation-check: FAIL — unvalidated request.body cast in a file that had none:" >&2
  echo "$new" | sed 's|^|  - backend/src/modules/|' >&2
  cat >&2 <<'MSG'

A route that casts request.body instead of parsing it does not reject a wrong
body — it reads the misspelled field as undefined, silently skips whatever that
field controlled, and returns 200.

Fix it rather than adding to the allowlist:

    import { parseBody } from '../../shared/validate-body.js';
    const body = parseBody(someSchema, request.body);

Author `someSchema` in @insula/api-contracts from what the HANDLER reads — never
from what the panel currently sends, and never from an existing schema you have
not checked against the handler. Prefer `.strict()` on PATCH: Zod STRIPS unknown
keys by default, which preserves the exact silence being removed.

If the body genuinely is not JSON (a raw webhook Buffer, a form-encoded
callback), add the file to scripts/.route-body-cast-allowlist.txt with the
reason.
MSG
  exit 1
fi

# Entries that no longer have a cast are stale. Not a failure — removing a cast
# is the goal — but an unreported stale entry silently re-licenses the file if a
# cast comes back later.
stale=$(comm -23 <(echo "$allowed") <(echo "$actual") || true)
if [[ -n "$stale" ]]; then
  echo "ci-route-body-validation-check: NOTE — allowlisted files with no cast left (remove them):"
  echo "$stale" | sed 's|^|  - |'
fi

count=$(echo "$actual" | grep -c . || true)
echo "ci-route-body-validation-check: OK ($count allowlisted files carry a cast; no new ones)"
