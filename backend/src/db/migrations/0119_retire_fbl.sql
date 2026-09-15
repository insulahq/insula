-- Retire FBL (feedback-loop / ARF complaint) ingestion.
--
-- Measured on production 2026-09-15 before writing this: ZERO complaints
-- ingested in the feature's entire life, and no `fbl@` mailbox had ever been
-- created. The intake was anchored to the SYSTEM tenant's apex email domain,
-- and in the real deployment the apex has no email domain at all — the
-- provisioner logged "skipped" on every 5-minute tick since install. FBL also
-- requires manual per-provider enrolment (Microsoft JMRP/SNDS, Yahoo CFL) with
-- production IPs. Operator decision: retire it.
--
-- Each statement runs independently (the runner is not transactional), so
-- every one is written to be safely re-runnable.

-- 1. Complaint history. IF EXISTS because a cluster that never ran the R4
--    migrations has no such table, and a failure here would block the file.
DROP TABLE IF EXISTS email_fbl_complaints;

-- 2. Threshold-firing dedupe for the complaint evaluator, which is gone.
DROP TABLE IF EXISTS email_complaint_events;

-- 3. `mail_enforcement_mode` = 'auto' is no longer a valid value.
--
--    `auto` existed ONLY to act on complaint rates — `mode === 'auto'`
--    appeared exactly once in thresholds.ts, inside the complaint evaluator.
--    Leaving the stored value would give an operator a setting that promises
--    automatic enforcement and silently does nothing, which is precisely the
--    stored-and-ignored class this codebase has spent real effort deleting.
--    'notify' is what 'auto' would now do anyway, so the migration is
--    behaviour-preserving.
--
--    Deliberately NOT a CHECK constraint: an enum-ish platform setting is read
--    through a parser that already coerces unknown values to 'notify', and a
--    constraint here would fail the whole file on any cluster holding a value
--    written by a future release.
UPDATE platform_settings
   SET setting_value = 'notify'
 WHERE setting_key = 'mail_enforcement_mode'
   AND setting_value = 'auto';
