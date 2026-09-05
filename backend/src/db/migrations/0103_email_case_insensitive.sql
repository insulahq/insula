-- Account emails become case-insensitive identities.
--
-- Every lookup compared `users.email` with `=`, so an identity provider that
-- asserted `Staff@Example.test` for an account stored as `staff@example.test`
-- matched nothing. On the OIDC path that is not a failed login: the tenant
-- branch falls through to auto-provisioning and mints an ENTIRELY NEW TENANT
-- for someone who already had an account.
--
-- The domain part is case-insensitive per RFC 5321; the local part technically
-- is not, but no mainstream provider treats it that way and an IdP may vary the
-- casing it asserts between logins.

-- 1. Normalise the values that can be normalised without colliding.
--
--    A row is skipped when lowercasing it would land on an address another row
--    already holds. Merging two accounts is an operator decision about which
--    one survives — not something a migration may take. Skipped rows keep
--    working: the application prefers an EXACT match before falling back to a
--    case-insensitive one, so the address the caller actually typed still wins.
UPDATE users u
   SET email = lower(u.email)
 WHERE u.email <> lower(u.email)
   AND NOT EXISTS (
     SELECT 1 FROM users o
      WHERE o.id <> u.id
        AND lower(o.email) = lower(u.email)
   );

UPDATE tenants t
   SET primary_email = lower(t.primary_email)
 WHERE t.primary_email <> lower(t.primary_email)
   AND NOT EXISTS (
     SELECT 1 FROM tenants o
      WHERE o.id <> t.id
        AND lower(o.primary_email) = lower(t.primary_email)
   );

-- 2. Index the lowercased form so the new lookups stay index-backed.
--
--    NON-unique, deliberately. A unique index here would fail outright on any
--    cluster still holding two rows that differ only in case, and a failed
--    migration blocks the API from starting — turning a rare, benign data
--    quirk into an outage. The existing `users_email_unique` still enforces
--    uniqueness of the stored value, and step 1 has already collapsed every
--    case variant that could safely be collapsed.
--
--    Making this UNIQUE is a follow-up for an operator who has confirmed there
--    are no remaining case-duplicates:
--      SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS tenants_primary_email_lower_idx ON tenants (lower(primary_email));
