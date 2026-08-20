#!/usr/bin/env bash
#
# ci-internal-route-ratelimit-check.sh
#
# Guards the two halves of one decision about `/internal/*` routes.
#
# WHY THIS EXISTS
#
# The global limiter (backend/src/middleware/rate-limit.ts) keys on
# `user.sub ?? request.ip`. Machine-to-machine callers — the sftp-gateway, the
# Stalwart webhook, a backup Job — carry no JWT, so every request they make
# keys on the SAME caller pod IP. One 100-req/min bucket then covers every
# tenant at once.
#
# For the SFTP routes that meant roughly 25 SFTP logins per MINUTE for the
# entire platform (~4 internal calls per session), after which logins failed
# with a 429 no tenant could see or fix. The limit never throttled an attacker
# — it only ever throttled us.
#
# So `/internal/*` routes opt out. That is only safe because each one is
# already authenticated by a secret or an HMAC-signed capability token. This
# guard enforces both directions:
#
#   1. every `/internal/*` route declares a rateLimit setting, so the question
#      is answered deliberately rather than skipped
#   2. any route that opts OUT lives in a file with a real auth gate, so the
#      opt-out can never be copy-pasted somewhere it is not earned
#
# Rule 2 is the one that matters. Rule 1 just stops the question being missed.
#
# Adding a new auth mechanism means adding it to GATE_MARKERS below — a
# deliberate edit, reviewed like any other.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "== /internal/* route rate-limit + auth-gate guard =="

python3 - "$REPO_ROOT" <<'PY'
import os
import re
import sys

repo_root = sys.argv[1]
modules_dir = os.path.join(repo_root, 'backend', 'src', 'modules')

# Auth mechanisms that make opting out of the global limiter defensible.
# Each is a real primitive in this codebase, not a guess:
#   timingSafeEqual        constant-time compare of a shared internal secret
#                          (sftp-gateway, private-worker tunnel, system-tenant)
#   verifyWebhookSignature HMAC over the raw body, key derived from
#                          PLATFORM_INTERNAL_SECRET (Stalwart mail events)
#   verifyUploadToken      HMAC token bound to (bundleId, component, artifact)
#                          with a 30-minute expiry (tenant-bundle streaming)
#   assertInternalBearer   constant-time PLATFORM_INTERNAL_SECRET bearer check
#                          (mail-admin; wraps timingSafeEqual in its own module
#                          so the routes file does not name the primitive)
GATE_MARKERS = (
    'timingSafeEqual',
    'verifyWebhookSignature',
    'verifyUploadToken',
    'assertInternalBearer',
)

ROUTE_RE = re.compile(r"app\.(?:post|get|put|patch|delete)\(\s*")
CLOSERS = {'(': ')', '[': ']', '{': '}'}


def read_balanced(text, start):
    """Return (chunk, index_after) for the balanced group opening at `start`."""
    opener = text[start]
    closer = CLOSERS[opener]
    depth = 0
    i = start
    quote = None
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == '\\':
                i += 2
                continue
            if ch == quote:
                quote = None
        elif text.startswith('//', i) or text.startswith('/*', i):
            # Comments must be skipped, not scanned. An apostrophe in ordinary
            # prose ("the handler's token check") would otherwise open a string
            # that never closes, and the scanner swallows the rest of the file.
            i = skip_trivia(text, i)
            continue
        elif ch in ('"', "'", '`'):
            quote = ch
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start:i + 1], i + 1
        i += 1
    return None, len(text)


def read_string_literal(text, start):
    """Return (value, index_after) for a quoted string starting at `start`."""
    quote = text[start]
    if quote not in ('"', "'", '`'):
        return None, start
    i = start + 1
    out = []
    while i < len(text):
        ch = text[i]
        if ch == '\\':
            out.append(text[i + 1:i + 2])
            i += 2
            continue
        if ch == quote:
            return ''.join(out), i + 1
        out.append(ch)
        i += 1
    return None, len(text)


def skip_trivia(text, i):
    """Advance past whitespace and // or /* */ comments.

    Route options are frequently preceded by the comment explaining WHY the
    route is configured that way - so a scanner that only skips whitespace
    reads the comment as the options argument and reports the route as
    unconfigured. Which is exactly what this one did first time out.
    """
    while i < len(text):
        ch = text[i]
        if ch in ' \t\r\n':
            i += 1
        elif text.startswith('//', i):
            nl = text.find('\n', i)
            i = len(text) if nl == -1 else nl + 1
        elif text.startswith('/*', i):
            end = text.find('*/', i)
            i = len(text) if end == -1 else end + 2
        else:
            break
    return i


def options_expr(text, idx):
    """Given the index just past `app.post(`, return the options expression.

    Deliberately never descends into the handler body: after the path literal
    we look at the NEXT token only. An object literal or a bare identifier
    followed by a comma is the options argument; anything that starts a
    function (async, (, function) means there is no options argument.
    """
    path, i = read_string_literal(text, idx)
    if path is None:
        return None, None
    i = skip_trivia(text, i)
    if i >= len(text) or text[i] != ',':
        return path, ''
    i += 1
    i = skip_trivia(text, i)
    if i >= len(text):
        return path, ''
    if text[i] == '{':
        chunk, _ = read_balanced(text, i)
        return path, (chunk or '')
    ident_match = re.match(r'[A-Za-z_$][A-Za-z0-9_$]*', text[i:])
    if ident_match:
        ident = ident_match.group(0)
        if ident in ('async', 'function'):
            return path, ''
        after = text[i + len(ident):]
        if re.match(r'\s*,', after):
            return path, ident
    return path, ''


def resolve_identifier(text, ident, path_ts, depth=0):
    """Resolve `const <ident> = { ... }` to its object literal text.

    Follows a relative import when the identifier is not declared locally —
    shared route options legitimately live in a sibling module, and a resolver
    that gives up at the file boundary would report those routes as
    unconfigured and push authors to inline the options just to satisfy it.
    """
    m = re.search(r'\b(?:const|let|var)\s+' + re.escape(ident) + r'\s*(?::[^=]+)?=\s*', text)
    if m:
        start = m.end()
        if start < len(text) and text[start] == '{':
            chunk, _ = read_balanced(text, start)
            return chunk or ''
        nl = text.find('\n', start)
        return text[start:nl if nl != -1 else len(text)]

    if depth >= 3:
        return ''
    imp = re.search(
        r'import\s*(?:type\s*)?\{[^}]*\b' + re.escape(ident) + r'\b[^}]*\}\s*from\s*'
        r'[\'"](\.[^\'"]+)[\'"]',
        text,
    )
    if not imp:
        return ''
    rel = imp.group(1)
    if rel.endswith('.js'):
        rel = rel[:-3] + '.ts'
    elif not rel.endswith('.ts'):
        rel = rel + '.ts'
    target = os.path.normpath(os.path.join(os.path.dirname(path_ts), rel))
    if not os.path.isfile(target):
        return ''
    with open(target, 'r', encoding='utf-8') as fh:
        return resolve_identifier(fh.read(), ident, target, depth + 1)


failures = []
checked = 0
opted_out = 0
gate_marker_seen = False

ts_files = []
for root, _dirs, names in os.walk(modules_dir):
    for name in names:
        if name.endswith('.ts') and not name.endswith('.test.ts'):
            ts_files.append(os.path.join(root, name))

for path_ts in sorted(ts_files):
    with open(path_ts, 'r', encoding='utf-8') as fh:
        text = fh.read()
    if "'/internal/" not in text and '"/internal/' not in text:
        continue

    has_gate = any(marker in text for marker in GATE_MARKERS)
    if has_gate:
        gate_marker_seen = True
    rel = os.path.relpath(path_ts, repo_root)

    for m in ROUTE_RE.finditer(text):
        route_path, opts = options_expr(text, m.end())
        if route_path is None or not route_path.startswith('/internal/'):
            continue
        checked += 1

        opts_text = opts or ''
        if opts_text and re.fullmatch(r'[A-Za-z_$][A-Za-z0-9_$]*', opts_text):
            opts_text = resolve_identifier(text, opts_text, path_ts)

        if 'rateLimit' not in opts_text:
            failures.append(
                rel + ' :: ' + route_path + ' declares no rateLimit setting.\n'
                '      Machine-to-machine callers share ONE ip-keyed bucket across\n'
                '      every tenant. Choose explicitly: "config: { rateLimit: false }"\n'
                '      (requires an auth gate) or an explicit per-route max.'
            )
            continue

        if re.search(r'rateLimit\s*:\s*false', opts_text):
            if not has_gate:
                failures.append(
                    rel + ' :: ' + route_path + ' disables rate limiting with NO auth gate.\n'
                    '      Recognised gates: ' + ', '.join(GATE_MARKERS) + '.\n'
                    '      Add one, or keep a rate limit.'
                )
            else:
                opted_out += 1

# Vacuity guards: this script passing because its own patterns rotted is
# exactly the failure it exists to prevent.
if not ts_files:
    print('FAIL: no backend module sources found - wrong path?', file=sys.stderr)
    sys.exit(1)
if checked == 0:
    print('FAIL: found 0 /internal/ routes - the extraction logic is stale,',
          file=sys.stderr)
    print('      not the codebase clean.', file=sys.stderr)
    sys.exit(1)
if not gate_marker_seen:
    print('FAIL: no file with /internal/ routes matched any GATE_MARKER -',
          file=sys.stderr)
    print('      the marker list is stale.', file=sys.stderr)
    sys.exit(1)

print('  /internal routes checked : ' + str(checked))
print('  opted out behind a gate  : ' + str(opted_out))

if failures:
    print('')
    for f in failures:
        print('FAIL: ' + f, file=sys.stderr)
    print('')
    print('FAILED', file=sys.stderr)
    sys.exit(1)

print('  OK')
PY
