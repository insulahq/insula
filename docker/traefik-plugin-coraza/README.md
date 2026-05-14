# traefik-plugin-coraza

Container image that stages a Coraza WAF plugin onto Traefik's local-
plugin volume via an initContainer. Used by Phase 3 of the Traefik
migration to back the `coraza-base@traefik` / `coraza-platform@traefik`
/ `r-<routeId>-waf` Middlewares emitted by annotation-sync.

## Status — 2026-05-14: BLOCKED upstream

Both attempted approaches FAIL against Traefik v3.7.1:

### Attempt 1 — Yaegi local plugin (vendored Go source)

Plan: vendor github.com/hatsat32/coraza-traefik (Go source + vendor/ tree)
and load it via `experimental.localPlugins` (Yaegi-interpreted).

Result: Traefik startup fails because Coraza's
internal/corazawaf/rule.go imports `unsafe`, which Yaegi does not
implement. Pinned upstream issue: traefik/yaegi#1611 / generic
limitation.

```
ERR Plugins are disabled because an error has occurred.
error="... import \"unsafe\" error: unable to find source related
to: \"unsafe\""
```

### Attempt 2 — WASM plugin (corazawaf/coraza-http-wasm v0.3.0 + v0.2.2)

Plan: ship the pre-built TinyGo-compiled `coraza-http-wasm.wasm` and
load it via `experimental.localPlugins` with `.traefik.yml` set to
`runtime: wasm`.

Result: plugin LOADS successfully (`Plugins loaded. plugins=["coraza"]`)
but Traefik immediately panics with `runtime: split stack overflow`
before serving any traffic. Traefik's bundled wazero runtime + the
Coraza WASM module's call stack depth exceed Go's split-stack growth
limits. Same crash with v0.2.2 and v0.3.0.

```
fatal error: runtime: split stack overflow
goroutine 15 ... [running]
runtime.morestack
...
```

## What still ships from this directory

- `Dockerfile` + `plugin/.traefik.yml` — the WASM packaging is correct
  in shape; the moment a working coraza-http-wasm release lands (or
  Traefik upgrades wazero with a higher stack ceiling), this builds
  the right image. The Dockerfile downloads the WASM asset from
  GitHub releases — bump `--build-arg CORAZA_WASM_VERSION=...` to try
  a new tag.
- `plugin/.traefik.yml` declares `runtime: wasm` and the canonical
  module path `phoenix-platform/traefik-plugin-coraza`, which matches
  the `--experimental.localPlugins.coraza.moduleName=...` flag the
  Helm chart wires when CORAZA_PLUGIN_MODULE is set in bootstrap.sh.

## Working alternative — defer WAF for now

`scripts/bootstrap.sh` ships with `CORAZA_PLUGIN_MODULE=""` so Traefik
installs WAF-free. The WAF Middlewares (`coraza-base@traefik`,
`coraza-platform@traefik`, per-route `r-<id>-waf`) emitted by
annotation-sync remain in the cluster as declarative scaffolding;
Traefik refuses to apply Middlewares that reference an unknown plugin
slug, so the routes still serve traffic — just without WAF
inspection.

If WAF is required before upstream Coraza-on-Traefik stabilises, the
fallback is `github.com/madebymode/traefik-modsecurity-plugin v1.6.0`
(loads cleanly in the smoke test). That plugin proxies request bodies
to an EXTERNAL `owasp/modsecurity-crs` Deployment, so:
1. annotation-sync's per-route directive emission collapses to a single
   shared `modsecurity@traefik` Middleware (no per-route customisation)
2. A new ModSecurity Deployment + Service in the traefik namespace is
   required

Neither is wired today. The Phase 3 commit history captures the full
design — flipping to madebymode is a focused refactor when needed.
