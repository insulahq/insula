-- Email header / footer per notification provider.
--
-- Operator-authored HTML wrapped above and below every notification email the
-- provider sends (and its test email). Lives on the provider row next to the
-- other per-provider email identity (from_address / from_name), so a Source
-- routed through an override provider carries that provider's branding.
--
-- NOT NULL DEFAULT '' rather than nullable: empty IS the "no header" state —
-- the send path returns the email byte-for-byte unchanged — so there is no
-- second spelling of "unset" for a reader to tell apart from it. Validation
-- (20 KB cap, no active content) is in the API contract
-- (packages/api-contracts/src/notification-email-chrome.ts).
--
-- A constant default makes ADD COLUMN metadata-only; IF NOT EXISTS makes the
-- migration replay-safe.
ALTER TABLE notification_providers
  ADD COLUMN IF NOT EXISTS email_header_html TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email_footer_html TEXT NOT NULL DEFAULT '';
