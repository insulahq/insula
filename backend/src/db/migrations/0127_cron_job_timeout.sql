-- Per-job run ceiling for scheduled tasks.
--
-- The executor hard-coded 30s for a webcron ping and 300s for a command in a
-- deployment. Neither number fits every job: Moodle's admin/cli/cron.php took
-- 182s on a freshly installed site (measured on DEV 2026-09-17), and a course
-- backup or search reindex on a busy site takes longer than the 300s ceiling —
-- the run would be abandoned mid-flight and recorded as a failure while the
-- process kept going inside the pod.
--
-- NULL keeps the per-type default, so every existing row behaves exactly as it
-- did before this column existed.
ALTER TABLE cron_jobs
  ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER;
