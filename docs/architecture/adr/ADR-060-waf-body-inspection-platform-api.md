# ADR-060: WAF body inspection does not apply to the platform API

**Status:** Amended (2026-09-09) — the analysis stands; the WAF-configuration
implementation was tried, measured, and **rejected**. The accepted remedy is a
transport pattern, not a rule change. See *Decision* and *What was tried*.

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

**Do not attempt this with WAF configuration.** There is no mechanism in
ModSecurity v3 that exempts request bodies for a path prefix without either
disabling most of the ruleset or enumerating individual fields forever.

Instead, **content-bearing endpoints carry their payload as
`application/octet-stream`**, which ModSecurity never parses into `ARGS`. The
payload is then structurally invisible to the body rules while every other rule
keeps working, with no per-field maintenance.

This is already the platform's pattern and it is proven in production:

- `/files/upload-raw` (rule `9000105`) — the body IS the file.
- SQL Manager import — moved to `upload-raw` + `import-from-file`; verified
  end to end on DEV with the WAF in the request path, rows confirmed in MariaDB.

The cost per endpoint is one `ctl:ruleRemoveById=920420` (CRS rejects
`application/octet-stream` by default), which is a single fixed rule rather than
an open-ended list that grows with every new field.

## What was tried, and measured

All four were run against the real `modsec-crs` image with its real entrypoint,
sending live requests through it. `200` = passed, `403` = blocked.

| Mechanism | SQL in JSON body | `930130` URL rule | query-string SQLi | Verdict |
|---|---|---|---|---|
| `ctl:requestBodyAccess=Off` | passes | **404 — broken** | **401 — broken** | **rejected** |
| `ctl:responseBodyAccess=Off` | — | — | — | **does not exist in v3** |
| `ruleRemoveTargetByTag=…;REQUEST_BODY,ARGS_POST` | **403 — no effect** | 403 ✓ | 403 ✓ | insufficient |
| + `ctl:requestBodyProcessor=URLENCODED` | **403 — no effect** | 403 ✓ | 403 ✓ | insufficient |

**Why `requestBodyAccess=Off` is disqualified.** It does not disable body
parsing — it skips **the whole of phase 2**, where roughly 80% of CRS rules
live. The CRS project documents this as a complete-bypass footgun
("Disabling Request Body Access in ModSecurity 3 Leads to Complete Bypass",
2021-03-02). Measured here: `/api/v1/.env` stopped being blocked, and so did
SQL injection in a **query string**. It was shipped to DEV and reverted the same
hour.

**Why target-stripping is insufficient.** `REQUEST_BODY` and `ARGS_POST` do not
cover a JSON body: ModSecurity's JSON processor expands it into `ARGS:json.<field>`.
That is why the existing `9000104` names `ARGS:json.content` explicitly — a
per-field exclusion, which is exactly the open-ended list this ADR set out to
eliminate. Forcing `requestBodyProcessor=URLENCODED` does not change the result.

Everything else in this ADR — the rule-target split, the threat model, the
traffic analysis — is unaffected and remains the reasoning behind preferring
opaque transport over inspection exemptions.

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

- The carve-out list still grows, but only when a NEW transport endpoint is
  added — one `920420` exclusion each — rather than once per content type or
  per JSON field. `9000104` and `9000105` stay; they are that pattern.
- New content-bearing endpoints under `/api/v1/` need no WAF work. That is the
  point: the failure mode being removed is "feature ships, operator hits a 403
  in production, someone writes an exclusion".
- Outbound leak detection on API responses is gone. Accepted: it fired only on
  tenants' own files being returned to them.
- One shared modsec config serves all WAF'd traffic, so a scoping error reaches
  tenant sites. Mitigated by the host chain and by the test matrix below, which
  asserts a tenant host keeps coverage.
- Endpoints that still embed content in a JSON field keep tripping the WAF
  until they move to opaque transport. That is now a known, bounded backlog
  rather than an open-ended rule-tuning exercise.

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

**How to parse-test a rule change — and how NOT to.**

`nginx -t` in an ad-hoc pod is worthless here. Overriding the container
`command` (e.g. `sleep`) skips `/docker-entrypoint.sh`, so the nginx config that
loads the rules is never generated and `nginx -t` returns "syntax is ok" without
having read them. That harness returns rc=0 on a file that provably crashes the
real container — it has no power to fail, and it passed both the missing-action
bug and the `ctl:responseBodyAccess` bug straight through to a merge.

The check that works: run the **real image with its real command**, mounting the
candidate rules over
`/etc/modsecurity.d/owasp-crs/rules/REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf`,
and assert the container reaches Ready. Always control-test it by feeding the
known-broken file and confirming it FAILS; a parse check that has never failed
has not been shown to work.

Two failure modes it catches, both hit while writing this ADR:
- a chained `SecRule` with no action list at end-of-file bleeds into the next
  rule file — nginx refuses to start, 502 for every WAF request;
- an unsupported `ctl:` action makes the whole file unparseable.
