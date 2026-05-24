-- 0026_drop_pg_dump_schedules.sql
--
-- Drops the system_pg_dump_schedules table. The pg_dump scheduler was
-- removed 2026-05-24 because it duplicated barman-cloud's ScheduledBackup
-- pathway and the UI never tracked the operator's intent end-to-end
-- (target dropdown filtered on the legacy `active` flag and was always
-- empty). pg_dump survives as a super_admin-only on-demand tool for
-- cross-PG-major-version migrations.
--
-- This drop is destructive — any existing schedules silently stop firing.
-- For prod environments with active schedules, operators should record
-- their cron + target before applying so they can re-trigger pg_dump
-- manually via POST /api/v1/system-backup/pg-dump.

DROP TABLE IF EXISTS public.system_pg_dump_schedules CASCADE;
