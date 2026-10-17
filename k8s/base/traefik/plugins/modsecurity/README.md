# ModSecurity-CRS Traefik plugin (Insula's copy)

The `modsecurity-crs@traefik` Middleware runs this plugin. It sends each
request — method, URI, headers and body — to the ModSecurity-CRS sidecar
(`k8s/base/modsecurity-crs/`) and lets the request through only on a 2xx
verdict; 3xx and 4xx are returned to the client, a 5xx or no answer is a 502. It is a modified copy of
`madebymode/traefik-modsecurity-plugin` v1.6.0; `NOTICE` lists every change.

## Why the platform carries its own copy

Upstream's last release is v1.6.0 and its open issues and PR sit unanswered.
Two defects in it were serious for a shared ingress:

- **WAF bypass.** Any request carrying `Upgrade: websocket` skipped inspection,
  whatever its method or body — one header took a SQL-injection POST past the
  WAF, and the sidecar never logged it.
- **Request bodies in Traefik's heap.** `io.ReadAll` held every body (up to the
  12.5 MiB cap) for the whole request, on top of the copy `waf-body-limit`
  had already buffered. Measured with a 1 GiB limit: 15 parallel 12 MiB uploads
  took 541 MiB of heap; 40 OOM-killed Traefik. This copy serves 80 with
  285 MiB of heap.

Upstream issues addressed: #11 (custom error page — put Traefik's `errors`
middleware in front; tested), #18 (large uploads vs. the verdict timeout), #20 /
PR #19 (opt-in fail-open back-off; the platform keeps it off), #21
(X-Forwarded-For), #22 (jail deadlock — jail removed).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `modSecurityUrl` | — | Sidecar base URL; the request URI is appended. |
| `timeoutMillis` | 2000 | Wait for the verdict once the request is sent. |
| `bodyTimeoutMillis` | 10000 | Extra time allowed for sending the body. |
| `maxBodyBytes` | 13107200 | Larger bodies get 413 (ModSecurity's own default limit). |
| `memBodyBytes` | 65536 | In-memory share of a body this plugin spools itself. |
| `spoolDir` | `os.TempDir()` | Where spooled bodies go (unlinked on creation). |
| `maxConnsPerHost` / `maxIdleConnsPerHost` | 0 / 64 | Sidecar connection pool. |
| `unhealthyWafBackOffPeriodSecs` | 0 | > 0 lets requests through UNINSPECTED for that long after the sidecar fails. 0 answers 502. |
| `modSecurityStatusRequestHeader` | — | Request header recording the outcome, for access logs. |

Keys it does not know (upstream's `jail*`, the old `maxBodySize`) are dropped
by Traefik without an error.

## How it reaches Traefik

- `k8s/base/traefik/kustomization.yaml` turns `modsecurity.go`, `go.mod` and
  `.traefik.yml` into the ConfigMap `traefik/traefik-plugin-modsecurity`
  (Flux-applied, never pruned).
- The Traefik DaemonSet mounts it as a local plugin
  (`experimental.localPlugins.modsecurity`, type `localPath`) and carries the
  ConfigMap's content hash as the pod annotation
  `insula.host/modsecurity-plugin-sha256`. Fresh installs get this from
  `scripts/bootstrap.sh`; existing clusters from host-migration
  `2026.10.11/0002-traefik-modsecurity-plugin-local.sh`.
- Traefik reads plugin source only at startup. **Changing any of the three
  files therefore needs a host-migration that re-stamps the hash**, which rolls
  the DaemonSet one node at a time. `scripts/ci-migration-coverage.sh` fails a
  change to them that comes without one.

## Changing it

Traefik interprets this file with Yaegi, not the Go compiler. Constructs that
compile fine have failed under it (each measured on Traefik v3.7.6):

- a method value such as `dialer.DialContext` assigned to a func field;
- `req.Body == http.NoBody` when the body is an interpreted type (panic);
- asserting a compiled value to an interface declared in this package (false
  although the method exists);
- `reflect.ValueOf(x)` on an interface held in an interpreted variable (panic on
  every request). Reflect only on compiled values such as `req.Body`.
- an interpreted callback handed to compiled `net/http`, such as
  `http.Client.CheckRedirect` (panic when called — hence `Transport.RoundTrip`).

Run both suites before pushing (CI does too):

```bash
go test -race ./...
# Yaegi v0.16.1 = Traefik v3.7.6's interpreter; needs a GOPATH layout.
YAEGI_TEST=1 yaegi test github.com/insulahq/insula/traefik-plugins/modsecurity
```

Unit tests cannot see oxy's compiled buffer under Yaegi, so CI also runs the
plugin inside a real Traefik: `scripts/test-traefik-modsecurity-plugin-live.sh`
(Docker; the WAF bypass, websocket upgrades, 413, an `errors` page in front,
and buffer reuse proven by an unusable `spoolDir`).
