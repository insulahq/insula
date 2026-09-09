# ADR-060: WAF body inspection does not apply to the platform API

**Status:** Accepted (2026-09-09)

The OWASP CRS ruleset inspects request and response bodies on the admin and
tenant panel hosts. This ADR stops it doing that for `/api/v1/**` on those
hosts, and keeps every other rule. URL, method, header and query-string
inspection are unchanged, on the API and everywhere else.

## Context

The WAF exists to protect **tenant websites** from the internet. It was
attached to the panel hosts as well, which put the platform's own management
API behind a ruleset written for untrusted input.

The API is the opposite of untrusted input by design. Its job is to transport
content that is indistinguishable from an attack:

| Feature | What travels in the body | Rules it matches |
|---|---|---|
| SQL Manager import | a database dump | 942xxx (SQLi) |
| File Manager read/write | arbitrary file bytes | 953120 outbound, 930xxx, 933xxx |
| Compose editor | shell commands in YAML | 932xxx (RCE) |
| Env-var editor | `.env` contents | 930xxx |
| Cron editor | shell command lines | 932xxx |
| WAF exclusion editor | an attack pattern, literally | whichever family it describes |
| Node terminal | shell commands | 932xxx |

This is not a tuning gap that better rules would close. Every one of those is a
*correct* match on content the caller is entitled to send, so the false-positive
rate is a property of the design, not of the configuration.

The evidence for that is the carve-out list itself. Three already exist, each
added after an incident:

- `/files/upload-raw` — every raw upload failed (920420 rejects
  `application/octet-stream`).
- `/admin/security/waf-rule-exclusions` — an operator could not whitelist a
  false positive, because submitting the exclusion tripped the rule it
  described. The safety valve was behind the thing it disarms.
- `/files/(read|write|download)` — 953120 fires on the *response* when a tenant
  saves a PHP file (2026-09-09; ADR-060's immediate trigger).

Each was found in production, by a user hitting it. The next content-bearing
feature is the next incident, and the list has no natural end.

### What the rules actually inspect

Read off the live CRS 4.28 rule files in the running `modsec-crs` image, not
inferred:

| Rule | Catches | Target |
|---|---|---|
| `930130` | the `.env` sweeps — 232 hits/30d | `REQUEST_FILENAME` |
| `920440` | restricted extensions | `REQUEST_BASENAME` |
| `911100` | method abuse | `REQUEST_METHOD` |
| `920420` | disallowed content-type | `REQUEST_HEADERS:Content-Type` |
| `942190` `942350` | **our false positives** | `ARGS`, `REQUEST_COOKIES`, `XML` |
| `933120` | **our false positive** | `ARGS`, `REQUEST_COOKIES`, `XML` |
| `953120` | **our false positive** | `RESPONSE_BODY` |

The split is clean and it is the whole basis of this decision: **everything
that catches a real attack reads the URL, method or headers. Everything that
false-positives reads a body.** Nothing in the first group is affected here.

### Traffic

30 days of `waf_logs` on production: **558 events, 18 under `/api/v1/`.** Of
those 18, **16 came from the operator's own address** — legitimate work
misclassified. Two were genuine: `GET /api/v1/.env`, a scanner appending a
known filename to a path prefix, caught by `930130` on `REQUEST_FILENAME`.

That request is still blocked after this change. It was never a body match.

Traffic counts are a weak argument on their own — attackers change targets, and
"nobody probes the API today" does not mean nobody will. The decision therefore
does **not** rest on it. It rests on the rule-target split above, which holds
regardless of what attackers do next: a future scanner probing `/api/v1/…` is
caught on the URL, exactly as today's is.

## Decision

For `/api/v1/**` on the admin/tenant/api panel hosts only:

```
SecRule REQUEST_HEADERS:X-Forwarded-Host "@rx ^(admin|tenant|api)\." \
    "id:9000114,phase:1,pass,nolog,chain,\
     ctl:requestBodyAccess=Off,ctl:responseBodyAccess=Off"
    SecRule REQUEST_URI "@rx ^/api/v1/" "t:none"
```

Everything else stays: URL, method, header and **query-string** rules all still
apply, on the API and everywhere else.

### What is explicitly NOT exempted

- **Tenant websites.** The `X-Forwarded-Host` chain scopes this to panel hosts.
  A tenant app serving its own `/api/v1/` on its own domain keeps full
  coverage — the same reasoning already applied by `9000103`.
- **Query-string arguments.** `ARGS` covers query *and* body args; turning off
  body access removes only the body half. `?id=1' OR 1=1--` against any API
  endpoint is still matched by the 942xxx family.
- **Non-API paths on the panel hosts.** The SPA, its assets and every other
  path keep full inspection.
- **The request-body size cap.** `waf-body-limit` stays attached everywhere the
  WAF is. It is a DoS control, not an inspection control: an unbounded POST
  OOM-killed Traefik in ~3s on a live cluster.
- **CrowdSec.** IP reputation and ban decisions run on every route, unchanged.

## Threat model

**What we give up:** body-payload detection for a request that has already
passed authentication. Mutating endpoints are Bearer-only with no cookie
fallback, so this requires a valid token — a compromised admin or tenant
session.

**Why that is acceptable:**

1. The API does not build SQL from request bodies. A sweep of
   `backend/src/modules/` finds **no string-concatenated SQL**; queries go
   through Drizzle, whose `sql` tagged template parameterises every
   interpolation. CRS's SQLi rules were never what stood between a body and the
   database.
2. Inputs are validated at the boundary. 78 of 105 route modules parse with Zod
   schemas from `@insula/api-contracts`, and `.strict()` on mutation schemas
   rejects unknown keys outright.
3. RBAC and tenant-scoping are enforced in the application, not the WAF.
4. **An authenticated admin can already do everything the body rules would
   "prevent"** — run arbitrary SQL through SQL Manager, write arbitrary files
   through File Manager, and execute shell commands through the node terminal.
   Those are the product. Blocking a SQL keyword in a JSON body while shipping a
   SQL console is not a security boundary; it is an inconsistency.
5. The identical bytes already reach the same volumes over SFTP, which has no
   WAF in front of it at all.

**What we keep:** every pre-authentication control. The WAF runs before auth, so
an unauthenticated attacker still meets the URL, method, header and query-string
rules, plus CrowdSec and the body cap, before the application sees anything.

## Consequences

- The carve-out list stops growing. `9000104`, `9000105` and `9000113` become
  redundant and are left in place only until this ships and is verified, then
  removed in a follow-up so the file does not accumulate dead rules.
- New content-bearing endpoints under `/api/v1/` need no WAF work. That is the
  point: the failure mode being removed is "feature ships, operator hits a 403
  in production, someone writes an exclusion".
- Outbound leak detection on API responses is gone. Accepted: it fired only on
  tenants' own files being returned to them.
- One shared modsec config serves all WAF'd traffic, so a scoping error reaches
  tenant sites. Mitigated by the host chain and by the test matrix below, which
  asserts a tenant host keeps coverage.
- If a future audit requires body inspection on the API, the fix is to put the
  payload somewhere CRS does not parse (`application/octet-stream`), not to
  re-enable the rules — see the SQL import, which took that route and works.

## Verification

Asserted on DEV before and after, driving the real ingress with modsec-crs in
the path (`scripts/integration-waf-api-scope.sh`):

| Probe | Expected |
|---|---|
| SQL dump in a JSON body | passes (was 403) |
| PHP file save via File Manager | no 953120 row |
| `GET /api/v1/.env` | **still blocked** |
| `?id=1' OR 1=1--` on an API path | **still blocked** |
| Disallowed method on an API path | **still blocked** |
| `/api/v1/…` on a TENANT host | **still fully inspected** |
| non-API path on a panel host | **still fully inspected** |

The rule file is parse-tested against the exact production image before it
ships. A chained `SecRule` with no action list at end-of-file bled into the
next-loaded file once before and returned 502 for every WAF request; whichever
rule is last must carry an action list.
