---
verified: 2026.6.7
---

# API conventions

Everything the panels do goes through the management API at `/api/v1/` — and
you can call it yourself for automation. This page covers the conventions; the
endpoint catalogue lives in the interactive Swagger UI served by your own
installation and in the
[API specification](https://github.com/insulahq/insula/blob/main/docs/architecture/MANAGEMENT_API_SPEC.md).

## Authentication

Bearer JWTs:

```text
Authorization: Bearer <access-token>
```

Access tokens are short-lived (30 minutes) and paired with database-backed
refresh tokens; refresh-token rotation includes reuse detection. Tokens carry
`sub`, `role`, `exp`, `iat`.

## Response envelope

Every response uses the same shape:

```json
{
  "data": { },
  "pagination": { "nextCursor": "…", "limit": 50 },
  "error": null
}
```

On failure, `data` is `null` and `error` carries a machine-readable code plus a
human message:

```json
{
  "data": null,
  "error": { "code": "RESERVED_PLATFORM_HOSTNAME", "message": "…" }
}
```

Codes are `SCREAMING_SNAKE_CASE` — see [error codes](error-codes.md).

## Pagination

Cursor-based. Pass `limit` (1–100, capped server-side) and follow
`pagination.nextCursor` until it is null. There are no page numbers — cursors
stay correct while data changes underneath you.

## Field naming

Request and response fields are `camelCase`. All input is schema-validated;
unknown or malformed fields fail fast with a `400` validation error rather
than being silently ignored.

??? info "Under the hood"
    Every request/response type is defined once in the
    [`@insula/api-contracts`](https://github.com/insulahq/insula/tree/main/packages/api-contracts)
    package as Zod schemas — the backend validates with them and both panels
    derive their TypeScript types from them, so the API documentation you read
    is the same source the code compiles from.
