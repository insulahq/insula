-- Drop the retired per-domain spam thresholds (ROADMAP R47).
--
-- email_domains.spam_threshold_junk / spam_threshold_reject held the tenant
-- panel's per-domain "Junk folder / Reject" scores. Nothing ever sent them to
-- the mail server, and nothing could: Stalwart's thresholds
-- (SpamSettings.scoreSpam / scoreReject) are single numbers for the whole
-- server. The thresholds are now a server-wide Mail Settings value
-- (mail-admin/spam-policy.ts); no production domain had changed its own.
--
-- Dropped in the SAME release that stopped reading them, by operator
-- decision — not the expand/contract split of 0046/0150. The
-- cost, accepted: during the upgrade the previous release's API pods still
-- serve until the rollout replaces them, and they SELECT both columns by
-- name on every email-domain read. For that window (minutes) their email
-- pages and the email-domain reads of their mail jobs fail with 42703
-- "column does not exist"; it clears once the last old pod is gone.
--
-- Tenant bundles taken before the drop still carry both columns in their
-- config dump: RETIRED_BUNDLE_COLUMNS (backup-restore/executors/_shared.ts)
-- skips them on restore — keep that entry while such bundles can be restored.
--
-- IF EXISTS makes the statement replay-safe under the non-transactional
-- runner.
ALTER TABLE "email_domains"
  DROP COLUMN IF EXISTS "spam_threshold_junk",
  DROP COLUMN IF EXISTS "spam_threshold_reject";
