---
verified: 2026.6.7
---

# Error codes

API errors return a `SCREAMING_SNAKE_CASE` code you can match on. The codes
below are the ones you'll meet most often; the
[full catalogue with remediation steps](https://github.com/insulahq/insula/blob/main/docs/architecture/API_ERROR_HANDLING.md)
ships with the source.

## Authentication & permissions

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `MISSING_BEARER_TOKEN` | 401 | No/invalid `Authorization` header |
| `EXPIRED_TOKEN` | 401 | Access token expired — refresh it |
| `SESSION_EXPIRED` | 401 | Re-authenticate |
| `INSUFFICIENT_PERMISSIONS` | 403 | Your role can't do this |
| `STEP_UP_UNAVAILABLE` | 409 | Action needs a fresh credential check, but your account has no re-checkable credential (OIDC-only) |

## Validation

| Code | HTTP | Meaning |
|---|---|---|
| `MISSING_REQUIRED_FIELD` | 400 | A required field is absent |
| `INVALID_FIELD_FORMAT` / `INVALID_FIELD_VALUE` | 400 | A field doesn't match the schema |

Validation errors name the field that was wrong, in both the message and an
`error.details.field` property — including the index of the offending element
for a list (`tenant_ids.2`) and the offending key itself when a request carries
a field the endpoint does not accept.

!!! note "Changed: a field the endpoint does not recognise is now an error"
    A number of endpoints previously accepted the request, ignored any field
    they did not recognise, and answered **200** — so a typo in a field name
    looked like success while nothing had changed. Those endpoints now return
    **400** naming the field instead.

    If a script of yours starts receiving `400 INVALID_FIELD_VALUE` where it
    used to get `200`, the field it names was never being applied: the call had
    not been doing what it appeared to do. Correct the field name rather than
    ignoring the error.

    Affected: catalog badges, EOL-scanner settings, TLS settings, ingress
    settings, tenant resource quotas, OIDC global settings, node recovery
    actions, capacity checks, snapshot schedules, DNS record pull/push,
    Postgres restore and promote, and the bulk actions for cron jobs, admin
    users, tenants and domains.
| `INVALID_PAGINATION_LIMIT` | 400 | `limit` must be 1–100 |

## Domains & provisioning

| Code | HTTP | Meaning |
|---|---|---|
| `RESERVED_PLATFORM_HOSTNAME` | 409 | That hostname is reserved by the platform (webmail, mail, panel hosts, …) |
| `PROVISION_QUOTA_EXCEEDED` | — | The tenant's plan quota is exhausted |
| `PROVISION_OVER_CAPACITY` | — | The cluster can't fit the workload right now |
| `CERT_RATE_LIMITED` | — | Let's Encrypt rate limit hit — wait before retrying ([troubleshooting](../operator/troubleshooting.md)) |
| `CERT_DNS_PROPAGATION` | — | Certificate waiting on DNS propagation |

## Cluster operations

| Code | HTTP | Meaning |
|---|---|---|
| `NODE_DRAIN_BLOCKED_LAST_NODE` | 409 | Refusing to drain the only node that can host tenants |
| `DRAIN_PRECHECK_FAILED` | 503 | Drain pre-checks could not complete |
| `DRAIN_LAST_REPLICA` / `DRAIN_PIN_CONFLICT` | — | Draining would take down a sole replica / conflicts with a pinned workload |

!!! tip "Errors in the panels"
    Both panels surface these codes in their error panes with the human
    message — when you report an issue, include the code; it identifies the
    exact failure path.
