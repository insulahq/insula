/**
 * Email normalisation for identity lookups.
 *
 * Every account lookup on this platform compared `users.email` with `=`, so an
 * identity provider that returned `Staff@Example.test` for an account stored as
 * `staff@example.test` matched nothing. On the OIDC path that is not a failed
 * login but a worse outcome: the tenant branch falls through to
 * auto-provisioning and mints an ENTIRELY NEW TENANT for someone who already
 * had an account.
 *
 * The domain part of an address is case-insensitive by RFC 5321, and while the
 * local part is technically case-SENSITIVE, no mainstream provider treats it
 * that way — and an IdP is free to vary the casing it asserts between logins.
 * Treating addresses as case-insensitive is what every operator expects.
 */

/** Lowercase + trim. Safe on undefined so callers need no branch. */
export function normalizeEmail<T extends string | null | undefined>(email: T): T {
  if (typeof email !== 'string') return email;
  return email.trim().toLowerCase() as T;
}
