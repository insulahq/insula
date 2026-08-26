-- 0090_retire_backup_target_activate.sql
--
-- The legacy target-"Activate" path is retired (operator decision
-- 2026-08-26): its routes, the longhorn-reconciler writer, and both UI
-- surfaces are deleted this release. The 3-class shim assignments are
-- the only backup routing; the DR CronJobs are fed by the shim bridge
-- (dr-cronjobs.ts), and Longhorn volume-level backups no longer exist.
--
-- Clear any still-active row so read-side fallbacks that filter on
-- active=true (snapshot-store legacy fallback, shim-first direct-store
-- fallbacks) resolve to "none" everywhere. The column itself stays for
-- now — dropping it is a follow-up schema cleanup once the read-side
-- fallbacks are removed with it.

UPDATE backup_configurations SET active = FALSE WHERE active = TRUE;
