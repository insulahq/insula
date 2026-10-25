-- cron_jobs.consecutive_failures: how many of the job's runs in a row have
-- failed through the tenant's own command or site. A run the platform could
-- not start, or stopped, neither adds to it nor clears it; a success clears it.
--
-- A job that runs again within the hour is reported once two runs in a row
-- have failed (cron-jobs/failure-streak.ts). On production almost every
-- failure notice was a single run followed by one that worked — a pod
-- restarted under it, a storage failover, one slow request.
--
-- A job whose last run failed starts at 1, so a job already broken across
-- this upgrade is reported on its next failure, not the one after.
ALTER TABLE cron_jobs
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

UPDATE cron_jobs SET consecutive_failures = 1
 WHERE "lastRunStatus" = 'failed' AND consecutive_failures = 0;
