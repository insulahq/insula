-- cron_jobs: opt-in failure email, per job.
--
-- A failed scheduled run already reaches the tenant's admins through their own
-- notification preferences. These columns let a job ALSO mail the tenant's
-- primary email and/or one extra address on failure.
--
--   notify_on_failure    off for every existing and new job unless switched on
--   notify_tenant_email  a flag, not a copy: the tenant's primary_email is read
--                        when the email is sent, so a changed address follows.
--                        TRUE so that switching the feature on with nothing
--                        else chosen mails the tenant.
--   notify_email         one extra, tenant-entered address (NULL = none)
--
-- Additive and idempotent; existing rows take the defaults, so no job starts
-- sending mail because of this migration.
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "notify_on_failure" boolean NOT NULL DEFAULT false;
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "notify_tenant_email" boolean NOT NULL DEFAULT true;
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "notify_email" varchar(255);
