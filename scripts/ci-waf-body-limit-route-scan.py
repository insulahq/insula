#!/usr/bin/env python3
"""Route-level half of scripts/ci-waf-body-limit-check.sh.

The shell guard's other checks are FILE-level: they confirm that
`modsecurity-crs` and `waf-body-limit` are both named in an emitter and pushed
in that order. A per-route `.filter()` that removes the cap from one route's
middleware list satisfies both and is still a hole, because the file still
mentions both names and the push order is unchanged.

The invariant that actually matters is per ROUTE:

    keeping the WAF while dropping the cap is safe ONLY on a route that
    cannot carry a request body.

The madebymode plugin does an unbounded `body, _ := io.ReadAll(req.Body)` before
asking the sidecar for a verdict. One 600 MB unauthenticated POST OOM-killed the
Traefik DaemonSet in ~3 s and took every site on the platform offline; the cap is
what turns that into a 413 in 0.33 s. A GET has no body to read, so a
GET-restricted route may drop the cap — and must, because the cap is a
`buffering` middleware that spools the whole RESPONSE to disk before releasing a
byte, which is what made multi-GB downloads look like a hang.

So: any route whose middleware list drops the cap but keeps the WAF must carry a
Method(`GET`) term. Lose that term and the carve-out becomes the 600 MB hole.
"""
import os
import re
import sys

EMITTER = "backend/src/modules/system-settings/ingress-reconciler.ts"
CAP_CONST = "WAF_BODY_LIMIT_MIDDLEWARE_NAME"
WAF_CONST = "PLATFORM_WAF_MIDDLEWARE_NAME"


def main() -> int:
    root = sys.argv[1]
    path = os.path.join(root, EMITTER)
    if not os.path.exists(path):
        print(f"FAIL: expected emitter missing: {EMITTER}", file=sys.stderr)
        return 1
    src = open(path).read()

    # Which middleware-list identifiers drop the cap, and which drop the WAF?
    drops_cap, drops_waf = set(), set()
    for m in re.finditer(r"const\s+(\w+)\s*=\s*panelMiddlewares\s*\.filter\(([\s\S]*?)\);", src):
        name, body = m.group(1), m.group(2)
        if CAP_CONST in body:
            drops_cap.add(name)
        if WAF_CONST in body:
            drops_waf.add(name)

    if not drops_cap:
        # Nothing drops the cap — nothing to check, but say so rather than
        # passing silently: a rename would otherwise make this guard vacuous.
        print("  OK  no middleware list drops the cap")
        return 0

    bad = 0
    checked = 0
    for m in re.finditer(r"traefikRoutes\.push\(\{([\s\S]*?)\n    \}\);", src):
        block = m.group(1)
        mw = re.search(r"middlewares:\s*(\w+)", block)
        # Line-based on purpose. The match expression is a TS template literal
        # whose backticks are ESCAPED (\`Host(...)\`), so any regex that stops
        # at the first backtick truncates it before the Method() term and the
        # check silently passes everything. Take the whole line instead.
        match = re.search(r"^\s*match:.*$", block, re.M)
        if not mw or not match:
            continue
        ident, expr = mw.group(1), match.group(0)
        if ident not in drops_cap or ident in drops_waf:
            continue
        checked += 1
        if "Method(\\`GET\\`)" not in expr:
            print(
                f"FAIL: a route using `{ident}` drops waf-body-limit but keeps the WAF "
                "with no Method(`GET`) term. The plugin reads the whole request body "
                "with no limit, so on a POST this is the 600 MB OOM again.",
                file=sys.stderr,
            )
            bad = 1
        else:
            print(f"  OK  route using `{ident}` drops the cap and is GET-restricted")

    if checked == 0:
        print(
            "FAIL: a middleware list drops the cap but no emitted route uses it — "
            "the scan matched nothing, so this guard proved nothing. Fix the scan, "
            "do not delete it.",
            file=sys.stderr,
        )
        return 1
    return bad


if __name__ == "__main__":
    sys.exit(main())
