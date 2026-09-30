#!/usr/bin/env python3
"""Route-level half of scripts/ci-waf-body-limit-check.sh.

The shell guard's other checks are FILE-level: they confirm that
`modsecurity-crs` and `waf-body-limit` are both named in an emitter and pushed
in that order. A per-route `.filter()` that removes the cap from one route's
middleware list satisfies both and is still a hole, because the file still
mentions both names and the push order is unchanged.

THE INVARIANT, per route:

    a route that attaches the WAF MUST also attach the cap.

No exceptions, and in particular **not** an HTTP-method exception.

★ This guard previously allowed exactly one: a route could drop the cap while
keeping the WAF if its rule carried a ``Method(`GET`)`` term, on the reasoning
that a GET has no request body for the plugin's unbounded
``io.ReadAll(req.Body)`` to read. That reasoning was wrong and the guard blessed
a real vulnerability. Traefik's ``Method()`` matches the verb string; it does not
reject a GET carrying a body, and the plugin has no method check. Measured
against a live ingress with the WAF attached and the cap dropped:

    GET + 40 MiB body, carved-out path -> uploaded=41,943,040 (all of it), 1.11 s
    GET + 40 MiB body, normal path     -> uploaded=1,113,941 then 413, 0.016 s

The entire body was buffered before ModSecurity returned a verdict — the same
mechanism as the incident where one 600 MB unauthenticated request OOM-killed
the Traefik DaemonSet in ~3 s and took every site on the platform offline.

★ Nor can a smaller request-only cap substitute. `waf-body-limit` is a
`buffering` middleware, and any buffering middleware spools the whole RESPONSE
to disk whatever its request settings are — which is the multi-minute download
stall the download carve-out exists to remove. A route that needs unbuffered
responses must drop the WAF as well, exactly as the upload carve-out does.

So there are only two legal shapes for a middleware list here:
  * keeps the WAF   -> must keep the cap
  * drops the WAF   -> may drop the cap (upload / download carve-outs)
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
    drops_cap, drops_waf, known = set(), set(), set()
    for m in re.finditer(r"const\s+(\w+)\s*=\s*panelMiddlewares\s*\.filter\(([\s\S]*?)\);", src):
        name, body = m.group(1), m.group(2)
        known.add(name)
        if CAP_CONST in body:
            drops_cap.add(name)
        if WAF_CONST in body:
            drops_waf.add(name)

    if not known:
        print(
            "FAIL: no `const X = panelMiddlewares.filter(...)` found. Either the "
            "carve-outs were renamed or this scan stopped matching — in which case "
            "it proves nothing. Fix the scan, do not delete it.",
            file=sys.stderr,
        )
        return 1

    bad = 0
    checked = 0
    for m in re.finditer(r"traefikRoutes\.push\(\{([\s\S]*?)\n    \}\);", src):
        block = m.group(1)
        mw = re.search(r"middlewares:\s*(\w+)", block)
        if not mw:
            continue
        ident = mw.group(1)
        if ident not in known:
            continue
        checked += 1
        keeps_waf = ident not in drops_waf
        keeps_cap = ident not in drops_cap
        if keeps_waf and not keeps_cap:
            print(
                f"FAIL: a route using `{ident}` attaches the WAF but drops "
                "waf-body-limit. The ModSecurity plugin reads the whole request "
                "body with io.ReadAll and no limit, for ANY method including GET, "
                "so this is the 600 MB Traefik OOM. Drop the WAF too (as the "
                "upload and download carve-outs do) — a smaller buffering "
                "middleware is not a substitute, it re-spools every response.",
                file=sys.stderr,
            )
            bad = 1
        elif not keeps_waf and not keeps_cap:
            print(f"  OK  route using `{ident}` drops the WAF and the cap together")
        elif not keeps_waf and keeps_cap:
            print(f"  OK  route using `{ident}` drops the WAF, keeps the cap")
        else:
            print(f"  OK  route using `{ident}` keeps both")

    if checked == 0:
        print(
            "FAIL: middleware lists exist but no emitted route references one — "
            "the scan matched nothing, so this guard proved nothing. Fix the scan, "
            "do not delete it.",
            file=sys.stderr,
        )
        return 1
    return bad


if __name__ == "__main__":
    sys.exit(main())
