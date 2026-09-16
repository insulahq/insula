-- Delete the `fbl@` mailbox ROWS that 0119 left behind.
--
-- 0119 retired FBL: it dropped `email_fbl_complaints` and the reconciler now
-- actively prunes `fbl@*` from Stalwart's intake patterns. What it did not do
-- is remove the platform-side `mailboxes` rows, so the DB kept claiming a
-- mailbox that Stalwart had correctly stopped serving.
--
-- Measured on DEV 2026-09-16:
--     550 5.5.0 Mailbox not found     <- RCPT TO fbl@<apex>
--     mail-drift: kind=mailbox, expectedName=fbl@<apex>, resolvedAt=NULL
--                 firstDetectedAt 2026-09-13  (unresolved for three days)
--
-- The row is not recoverable state: with FBL retired there is nothing to
-- deliver to it and nothing that reads it. Deleting it clears the drift at
-- source rather than leaving an operator to dismiss a warning that will
-- always be correct.
--
-- Scoped to local_part='fbl' so a tenant mailbox that merely happens to be
-- named similarly is untouched.
DELETE FROM mailboxes WHERE local_part = 'fbl';

-- Resolve any drift rows that referenced them, so the card clears without an
-- operator click. `resolved_via` records that this was a migration, not a
-- human dismissing it.
UPDATE mail_drift_items
   SET resolved_at = NOW(), resolved_via = 'fbl-retirement-0122'
 WHERE resolved_at IS NULL
   AND kind = 'mailbox'
   AND expected_name LIKE 'fbl@%';
