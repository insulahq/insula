-- The kept DKIM key copies (0178) get an `id`, so a tenant bundle can carry
-- them and a restore can put them back.
--
-- Without the copy a restored domain whose mail server lost its signatures is
-- given NEW keys, and its published DKIM records stop verifying until DNS is
-- changed. With it, the platform puts the same key back under the same
-- selector (email-dkim/restore.ts), and DNS stays as it is.
--
-- The bundle restore upserts on `id` alone, so the id is DERIVED from
-- (email_domain_id, selector) rather than random: a restored row then replaces
-- the live row of the same selector instead of colliding with it on the
-- (email_domain_id, selector) unique index and aborting the whole restore.
-- email-dkim/key-store.ts dkimKeyRowId computes the same value.
--
-- Idempotent: the runner is not transactional and replays the file.
ALTER TABLE email_dkim_private_keys ADD COLUMN IF NOT EXISTS id VARCHAR(36);

UPDATE email_dkim_private_keys
   SET id = substr(encode(sha256(convert_to('dkim-key:' || email_domain_id || ':' || selector, 'UTF8')), 'hex'), 1, 32)::uuid::text
 WHERE id IS NULL;

-- safety-reviewed: the UPDATE above fills every NULL id first (the derived
-- value is never NULL: both inputs are NOT NULL columns), so SET NOT NULL
-- cannot meet one, and on a replay there are none either.
ALTER TABLE email_dkim_private_keys ALTER COLUMN id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS email_dkim_private_keys_domain_selector_key
  ON email_dkim_private_keys (email_domain_id, selector);

DO $$
BEGIN
  -- The primary key moves from (email_domain_id, selector) to id; the pair
  -- stays unique through the index above.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'email_dkim_private_keys'::regclass
       AND c.contype = 'p'
       AND a.attname = 'id'
       AND array_length(c.conkey, 1) = 1
  ) THEN
    ALTER TABLE email_dkim_private_keys DROP CONSTRAINT IF EXISTS email_dkim_private_keys_pkey;
    ALTER TABLE email_dkim_private_keys ADD CONSTRAINT email_dkim_private_keys_pkey PRIMARY KEY (id);
  END IF;
END $$;
