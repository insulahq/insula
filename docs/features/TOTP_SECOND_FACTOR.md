# Authenticator-app second factor (TOTP)

User docs: `documentation/docs/tenant/account-and-security.md` (both panels share the flow),
`documentation/docs/admin/security.md` (the super_admin reset).

## Sign-in model

| Way to sign in | Needs |
|---|---|
| Password | email + password |
| Password + TOTP | email + password, then a 6-digit code or one backup code — when the user turned TOTP on |
| Passkey | the passkey alone, when passkey sign-in is on (`users.passkey_mode = 'alternative'`) |

There is no password-plus-passkey mode: a passkey is already two factors. Migration 0151 turned the
old `second_factor` rows into `alternative`; code that still reads one (from a pod that predates the
migration during a rolling upgrade) treats it the same. Nobody is required to enable TOTP.

## Code

- `backend/src/modules/auth/totp-core.ts` — RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step) and RFC 4648
  base32 on `node:crypto`; tested against both RFCs' vectors. Returns the matched **step**, not a boolean.
- `totp-service.ts` — storage and rules (below). Integration-tested against Postgres.
- `totp-routes.ts` — `GET /auth/totp`, `POST /auth/totp/{setup,enable,disable,backup-codes}`,
  `POST /auth/totp/login/verify`. Management refuses impersonation tokens (`IMPERSONATION_FORBIDDEN`):
  an admin acting as a tenant user must not switch the user's factor on or off.
- `pre-auth.ts` — the step-1 → step-2 token: a JWT with a `step` claim (every access-token verifier
  rejects tokens carrying one) plus a single-use row in `auth_consumed_tokens`.
- `session.ts` — `issueSession`: password, passkey and password+TOTP sign-ins all finish here.
- `/auth/login` returns `requires_totp` + `pre_auth_token` instead of a session when TOTP is on. Its
  200 response schema must name those fields — Fastify drops unnamed ones.
- Admin: `DELETE /admin/users/:userId/totp` (super_admin) and `totpEnabled` on both user lists.
- Recovery: `platform-ops admin reset-password` (`cli/admin-reset-password.ts`) and
  `scripts/admin-password-reset.sh` remove TOTP with the password reset.

## Invariants (totp-service.ts)

- **Two-step enrolment**: setup stores the secret with `enabled_at` NULL; only a correct code turns it
  on. A half-finished setup never gates sign-in. A new setup is refused while TOTP is on.
- **Secret at rest**: AES-256-GCM under `PLATFORM_ENCRYPTION_KEY` (`oidc/crypto.ts`).
- **A code works once**: accepting a code is one conditional UPDATE — `last_used_step` must be lower
  than the code's step — so two replicas cannot both accept it, and an older step in the window is
  refused after a newer one. A replayed code counts as a wrong one.
- **Lockout per user, in the DB**: 10 wrong codes in 15 minutes lock the factor until the window
  ends; a locked factor is not evaluated (`TOTP_LOCKED`, 429, `retry_after`). Per IP, the verify
  route is also rate-limited.
- **Backup codes**: 10 × 10 characters (no 0/O/1/I/L), shown once, stored as HMAC-SHA256 under a key
  derived (HKDF) from `PLATFORM_ENCRYPTION_KEY`, burned with an atomic `used_at IS NULL` update.
  Input is normalised (case, spaces, dashes).
- **Step 2 order**: the factor is checked before the pre-auth token is consumed, so a mistyped code
  does not cost the user their password step; guessing is bounded by the lockout.
- **Disable / regenerate** need a live code or a backup code — a hijacked session alone cannot.
