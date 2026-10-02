-- mail_migration_runs.step_timings — when each step of a mail migration began.
--
-- Why: a DR failover of an almost-empty mail store took ~4.5 min on a VM
-- drill and nobody could say where the time went — the per-step evidence was
-- only in platform-api logs, gone after the pod restarted. Each step now
-- appends {"step": <name>, "at": <timestamptz>} (plus a final 'done' /
-- 'failed'), so durations survive restarts and the status API can show them.
ALTER TABLE "mail_migration_runs" ADD COLUMN IF NOT EXISTS "step_timings" jsonb;
