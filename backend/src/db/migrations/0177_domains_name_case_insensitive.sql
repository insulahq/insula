-- Domain names are unique regardless of case.
--
-- `domains_name_unique` is a plain btree on domain_name, so it treats
-- `Example.test` and `example.test` as two names. DNS does not: they are one
-- name, one zone, one set of hostnames. The API now lowercases every new name
-- and compares case-insensitively; this index holds the same rule in the
-- database for any writer that bypasses the API.
--
-- Existing rows are NOT rewritten. A stored name with capitals is also the
-- name of its DNS zone, its certificate and its mail domain, and renaming it
-- here would strand those.
--
-- The index is created only when no two rows already differ only in case.
-- If some do, creating it would abort the boot (the runner is not
-- transactional and replays the file), so the block warns and skips instead,
-- and the API's case-insensitive check still refuses any new duplicate. The
-- file is recorded as applied either way, so after resolving the pair
-- (delete or move one of the domains) an operator creates the index by hand:
--   CREATE UNIQUE INDEX IF NOT EXISTS domains_name_lower_unique ON domains (lower(domain_name));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM domains GROUP BY lower(domain_name) HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'domains: names differing only in case exist; domains_name_lower_unique not created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS domains_name_lower_unique ON domains (lower(domain_name));
  END IF;
END $$;
