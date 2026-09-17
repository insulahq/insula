-- Timezone a scheduled task's expression is read in.
--
-- Schedules were evaluated in UTC with no way to say otherwise, so a tenant in
-- CEST asking for `0 3 * * *` got 05:00 local in summer and 04:00 in winter —
-- a nightly job that moves with the season and never runs when it says.
--
-- NULL means "follow the platform timezone" (system_settings.timezone), which
-- is what an operator expects after setting it once. It is deliberately not
-- backfilled with that value: a NULL follows later changes, while a stamped
-- row would silently stop following and nobody would know which was which.
ALTER TABLE cron_jobs
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
