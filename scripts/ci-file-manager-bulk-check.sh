#!/usr/bin/env bash
#
# CI guard — a multi-select action in the panel must send ONE request, never
# one request per selected path.
#
# Why this guard exists
# ---------------------
# 2026-09-02, production. A tenant moved ~120 files between two folders. The
# "Move To" dialog did this:
#
#     const promises = moveTarget.paths.map(sourcePath =>
#       renameFile.mutateAsync({ oldPath: sourcePath, newPath: dest }));
#     Promise.all(promises).then(() => { ... });
#
# Every file became its own HTTP request, all in flight at once — 62 requests
# in two seconds, measured in the platform-api log. That blew the global
# 100/min rate limit, and the resulting 429s did not stay inside the move: the
# panel's directory listings (115), its /me/tasks polls, and its
# /files/status polls (10) were rejected too. With /files/status failing, the
# Files page fell back to its "Starting file manager…" screen, so a perfectly
# healthy file-manager pod — zero restarts, running the whole time — looked to
# the operator like it had been killed and rebooted.
#
# `Promise.all` then rejected on the FIRST 429 while the other ~108 requests
# carried on succeeding. The user got a single "Too many requests" toast for a
# move that had partly worked, and no list of what had actually moved. They
# retried, and 33 of the retried renames answered 404 "Source not found"
# because those files had already been moved by the first attempt.
#
# Delete had already been fixed this way once (bulk-delete). Move, copy, chmod
# and chown were left looping — the same bug, four more times. This guard
# exists so the next multi-select action cannot quietly reintroduce it.
#
# Companion tests:
#   backend/src/modules/file-manager/bulk-stream.test.ts
#   backend/src/modules/file-manager/routes.test.ts       (bulk operations)
#   frontend/tenant-panel/src/__tests__/bulk-file-operations.test.tsx
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ROUTES="$REPO_ROOT/backend/src/modules/file-manager/routes.ts"
BULK_STREAM="$REPO_ROOT/backend/src/modules/file-manager/bulk-stream.ts"
PANEL_SRC="$REPO_ROOT/frontend/tenant-panel/src"

fail=0
note() { printf '  %s\n' "$*"; }
err()  { printf 'FAIL: %s\n' "$*" >&2; fail=1; }

echo "── file-manager bulk-operation guard ───────────────────────────────"

for f in "$ROUTES" "$BULK_STREAM"; do
  [ -f "$f" ] || { err "missing $f"; exit 1; }
done

# ── 1. Every bulk endpoint exists ───────────────────────────────────────────
#
# One endpoint per multi-select action the panel offers. Losing one sends that
# action straight back to a client-side loop.
for route in bulk-delete bulk-move bulk-copy bulk-chmod bulk-chown; do
  if grep -q "files/$route'" "$ROUTES"; then
    note "OK  /files/$route is served"
  else
    err "/files/$route route is missing from routes.ts"
  fi
done

# ── 2. No client-side per-path loop over a selection ────────────────────────
#
# Comment-aware: prose describing the old bug (this guard's own header, the
# explanatory comments in Files.tsx and use-file-manager.ts) must not trip it.
# Only real code counts, so line/block comments are stripped before matching.
python3 - "$PANEL_SRC" <<'PY'
import pathlib, re, sys

src = pathlib.Path(sys.argv[1])
problems = []

def strip_comments(text: str) -> str:
    # Block comments first, then line comments. Blank the content rather than
    # deleting it so reported line numbers stay true to the file.
    text = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)
    return re.sub(r'^\s*//.*$', '', text, flags=re.M)

def call_body(text: str, open_paren: int) -> str:
    """Text between `open_paren` and its matching `)`.

    A regex cannot do this: the real fan-out was
    `.map(sourcePath => { const name = sourcePath.split('/').pop() || ''; ... })`,
    whose callback contains both nested parens and semicolons. A `[^)]*` or
    `[^;]*?` pattern silently fails to span it — which is exactly how an
    earlier draft of this guard reported the two loop sites and missed the
    concurrent .map() that actually caused the incident.
    """
    depth = 0
    for i in range(open_paren, len(text)):
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
            if depth == 0:
                return text[open_paren:i + 1]
    return text[open_paren:]

# a) `.map()` whose callback fires a mutation. Mapping `.mutateAsync()` over a
#    list creates one in-flight request PER ITEM by construction — whether the
#    result goes to Promise.all, allSettled, or is just left floating.
MAP_CALL = re.compile(r'\.map\s*\(')

# b) an awaited mutation inside a loop over the current selection.
LOOP_OVER_SELECTION = re.compile(
    r'for\s*\(\s*const\s+\w+\s+of\s+(selected|selectedPaths|selectedDirs|\w*[Ss]election\w*)\b'
    r'(?:(?!\bfor\b).)*?await\s+[\w.]+\.mutateAsync\s*\(',
    re.S,
)

# Scope: the file-manager surface. This guard is about a multi-select over
# PATHS in the file manager; policing every list-render in the panel produces
# noise from JSX maps whose mutation is deferred inside an onClick handler.
TARGETS = [
    src / 'pages' / 'Files.tsx',
    *sorted((src / 'components' / 'files').rglob('*.tsx')),
    src / 'hooks' / 'use-file-manager.ts',
    src / 'hooks' / 'use-bulk-operation.ts',
    src / 'hooks' / 'use-trash.ts',
]

def fires_immediately(body: str, call_at: int) -> bool:
    """True when the map callback ITSELF invokes the mutation.

    `paths.map(p => mut.mutateAsync(p))` fires one request per item the moment
    the map runs. `entries.map(e => <Row onClick={() => mut.mutate(e)} />)`
    does not — the mutation sits behind a handler and fires once, on a click.
    The difference is whether another `=>` is crossed on the way in.
    """
    prefix = body[:call_at]
    first_arrow = prefix.find('=>')
    if first_arrow == -1:
        return False
    return '=>' not in prefix[first_arrow + 2:]

for path in TARGETS:
    if not path.exists() or path.name.endswith(('.test.ts', '.test.tsx')):
        continue
    code = strip_comments(path.read_text())
    rel = path.relative_to(src.parent.parent.parent)

    for m in MAP_CALL.finditer(code):
        body = call_body(code, m.end() - 1)
        hit = max(body.find('.mutateAsync('), body.find('.mutate('))
        if hit != -1 and fires_immediately(body, hit):
            line = code[:m.start()].count('\n') + 1
            problems.append(
                f'{rel}:{line}: .map() fires a mutation per item — that is one '
                'HTTP request per selected path. Send the whole selection to a '
                '/files/bulk-* endpoint instead'
            )

    for m in LOOP_OVER_SELECTION.finditer(code):
        line = code[:m.start()].count('\n') + 1
        problems.append(
            f'{rel}:{line}: '
            'awaited .mutateAsync() inside a loop over the selection — send the '
            'whole selection to a /files/bulk-* endpoint instead'
        )

if problems:
    print('FAIL: client-side per-path loop over a selection', file=sys.stderr)
    for p in problems:
        print(f'  {p}', file=sys.stderr)
    sys.exit(1)

print('  OK  no client-side per-path loop over a selection')
PY
[ $? -eq 0 ] || fail=1

# ── 3. last-access is patched ONCE per batch, never per path ────────────────
#
# recordFileManagerAccess PATCHes the file-manager Deployment. Calling it per
# path turned one selection into dozens of concurrent writes on a single
# object — visible in the k3s journal as deployment_controller conflict spam.
python3 - "$ROUTES" <<'PY'
import re, sys

text = open(sys.argv[1]).read()
text = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)
text = re.sub(r'^\s*//.*$', '', text, flags=re.M)

# Body of each bulk route: from its app.post( to the start of the NEXT route
# of any kind. Bounding on the next *bulk* route would run the last one to EOF
# and sweep in every route after it.
all_routes = [m.start() for m in re.finditer(r"app\.(post|get)\('/tenants/:tenantId/files", text)]
routes = list(re.finditer(r"app\.post\('/tenants/:tenantId/files/(bulk-[a-z]+)'", text))
problems = []
for m in routes:
    later = [s for s in all_routes if s > m.start()]
    end = min(later) if later else len(text)
    body = text[m.start():end]
    name = m.group(1)

    calls = body.count('recordFileManagerAccess(')
    if calls != 1:
        problems.append(f'{name}: expected exactly 1 recordFileManagerAccess() call, found {calls}')

    # It must sit ahead of the streaming loop, not inside the per-path runner.
    rec = body.find('recordFileManagerAccess(')
    stream = body.find('streamBulkPathOperation(')
    if rec == -1 or stream == -1 or rec > stream:
        problems.append(f'{name}: recordFileManagerAccess() must run once BEFORE streamBulkPathOperation()')

    # Validation must precede the hijack or the error handler has no response
    # left to write a proper envelope into.
    parse = body.find('safeParse(')
    hijack = body.find('reply.hijack()')
    if parse == -1 or hijack == -1 or parse > hijack:
        problems.append(f'{name}: input must be validated BEFORE reply.hijack()')

if not routes:
    print('FAIL: no bulk routes found to check', file=sys.stderr)
    sys.exit(1)

if problems:
    print('FAIL: bulk route structure', file=sys.stderr)
    for p in problems:
        print(f'  {p}', file=sys.stderr)
    sys.exit(1)

print(f'  OK  {len(routes)} bulk routes patch last-access once, before streaming')
PY
[ $? -eq 0 ] || fail=1

# ── 4. A per-path failure must never abort the batch ────────────────────────
#
# The executor has to attempt every path. A `break`/`return`/`throw` on the
# failure branch is precisely the bug that left production with a partial move
# nobody could see.
if grep -qE '^\s*(break|return|throw)\b' <(sed -n '/failed\.push/,/^    }/p' "$BULK_STREAM"); then
  err "bulk-stream aborts the batch on a per-path failure — every path must be attempted"
else
  note "OK  a per-path failure does not abort the batch"
fi

# The stream must always terminate in a frame the client recognises; a stream
# that just stops is reported to the user as "stopped unexpectedly".
if grep -q "type: 'complete'" "$BULK_STREAM" && grep -q "type: 'error'" "$BULK_STREAM"; then
  note "OK  bulk-stream emits terminal complete/error frames"
else
  err "bulk-stream must emit both a 'complete' and an 'error' terminal frame"
fi

# ── 4b. The per-request cap must stay under the WAF's argument ceiling ──────
#
# ModSecurity's JSON body processor turns every array element into its own
# ARGS entry, and rule 200007 refuses a request once the count reaches 1000:
#
#   ModSecurity: Access denied with code 400 (phase 2). Matched "Operator
#   `Ge' with parameter `1000' against variable `ARGS' (Value: `1000')
#   [id "200007"] [msg "Failed to fully parse request body due to large
#   argument count"]
#
# That refusal happens at the EDGE — a bare nginx 400, no error envelope, the
# API never sees it. Measured on a live cluster (2026-09-02): 900 paths pass,
# 1000 are refused. Raising the cap back to 1000 would make the documented
# maximum unreachable, so the guard pins it.
CONTRACTS="$REPO_ROOT/packages/api-contracts/src/files.ts"
if [ -f "$CONTRACTS" ]; then
  cap=$(grep -oP 'export const MAX_BULK_PATHS = \K[0-9]+' "$CONTRACTS" || echo "")
  if [ -z "$cap" ]; then
    err "MAX_BULK_PATHS not found in api-contracts"
  elif [ "$cap" -ge 1000 ]; then
    err "MAX_BULK_PATHS=$cap reaches the ModSecurity 200007 ARGS ceiling (1000) — requests would die at the edge as a bare nginx 400"
  else
    note "OK  MAX_BULK_PATHS=$cap is under the WAF 1000-ARG ceiling"
  fi
else
  err "missing $CONTRACTS"
fi

# The panel must SPLIT a larger selection rather than refuse it.
if grep -q 'streamBulkInChunks' "$PANEL_SRC/hooks/use-file-manager.ts"; then
  note "OK  panel chunks a selection larger than the cap"
else
  err "panel must split selections larger than MAX_BULK_PATHS into consecutive requests"
fi

# ── 5. A failed status poll must not become a fast status poll ──────────────
#
# The Files page polls /files/status every 2s while the file-manager starts.
# Applying that cadence to an ERRORED query made a rate-limited panel retry ten
# times in thirteen seconds against the bucket that was rejecting it.
FM_HOOK="$PANEL_SRC/hooks/use-file-manager.ts"
if [ -f "$FM_HOOK" ]; then
  if grep -q "query.state.status === 'error'" "$FM_HOOK"; then
    note "OK  status poll backs off when the query is failing"
  else
    err "useFileManagerStatus must back off its refetchInterval on an errored query"
  fi
else
  err "missing $FM_HOOK"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "file-manager bulk-operation guard FAILED" >&2
  exit 1
fi
echo "file-manager bulk-operation guard passed"
