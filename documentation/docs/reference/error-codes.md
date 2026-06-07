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
