-- 0089_backfill_mail_schedule_enabled.sql
--
-- The mail snapshot executor historically ignored
-- backup_schedules.mail.enabled — snapshots ran whenever a mail-class
-- target was bound, regardless of the toggle (seeded FALSE in 0011).
-- The executor now honors the toggle (snapshot-cronjob-reconciler +
-- firing engine), so any cluster that is actively snapshotting via a
-- bound mail target must have the flag flipped to TRUE first, or this
-- release would silently stop its mail backups.
--
-- Scope: only the 'mail' row, and only where a mail-class target
-- assignment exists (i.e. the cluster was really running snapshots).
-- Clusters with no mail binding keep enabled=FALSE — nothing was
-- running there and the operator still has to opt in.

UPDATE backup_schedules
SET enabled = TRUE
WHERE subsystem = 'mail'
  AND enabled = FALSE
  AND EXISTS (
    SELECT 1 FROM backup_target_assignments a
    WHERE a.backup_class = 'mail'
  );
