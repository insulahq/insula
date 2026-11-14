-- email_dkim_private_keys.id (0180) is NOT NULL with no default. During a
-- rolling deploy a pod still running the previous release inserts without an
-- id; its insert would fail, and since keeping a copy never fails signing, it
-- would fail SILENTLY: the new key would simply have no copy.
--
-- A column default cannot use other columns, so a BEFORE INSERT trigger fills
-- a missing id with the same derived value 0180 backfilled and
-- email-dkim/key-store.ts dkimKeyRowId computes. Rows that bring an id keep it.
--
-- Idempotent: the runner is not transactional and replays the file.
CREATE OR REPLACE FUNCTION email_dkim_private_keys_fill_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := substr(encode(sha256(convert_to('dkim-key:' || NEW.email_domain_id || ':' || NEW.selector, 'UTF8')), 'hex'), 1, 32)::uuid::text;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS email_dkim_private_keys_fill_id ON email_dkim_private_keys;
CREATE TRIGGER email_dkim_private_keys_fill_id
  BEFORE INSERT ON email_dkim_private_keys
  FOR EACH ROW EXECUTE FUNCTION email_dkim_private_keys_fill_id();
