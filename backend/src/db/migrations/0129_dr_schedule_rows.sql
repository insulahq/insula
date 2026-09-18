-- Give the three DR artefacts a schedule row, so their cadence becomes
-- something an operator can see and change.
--
-- Until now the System Backups page rendered NO schedule cards at all
-- (`scheduleSubsystems={[]}`), and the cadence of these three lived only in
-- manifests an operator cannot reach:
--
--   etcd snapshot upload   CronJob platform/etcd-snap-via-shim        0 * * * *
--   secrets bundle         CronJob platform/platform-secrets-backup   15 3 * * *
--   cluster state          CronJob platform/platform-cluster-state-backup  0 3 * * *
--
-- The cron values below are exactly those manifest defaults, so seeding this
-- table changes NOTHING about when the jobs run. The reconciler treats
-- "row matches the manifest default" as native mode and leaves the CronJob to
-- fire itself; only an operator edit moves a job onto platform-driven firing.
--
-- `enabled` mirrors what is already true on a bound cluster: these jobs run
-- whenever the SYSTEM backup class has a target, and the existing dr-cronjobs
-- bridge owns their suspend flag. Seeding TRUE therefore preserves current
-- behaviour; the strict-gate in the API still refuses to ENABLE them from the
-- UI on a cluster with no SYSTEM target bound.
--
-- retention_days / retention_count stay NULL: retention for these three is
-- enforced inside the job scripts (the etcd job keeps the newest 24 objects),
-- not from this table. A number here would be a control that does nothing —
-- the UI reads NULL as "not applicable" and hides the field.

INSERT INTO public.backup_schedules (subsystem, enabled, cron_expression, retention_days, retention_count, updated_at)
VALUES
  ('etcd_snapshot',  TRUE, '0 * * * *',  NULL, NULL, NOW()),
  ('secrets_bundle', TRUE, '15 3 * * *', NULL, NULL, NOW()),
  ('cluster_state',  TRUE, '0 3 * * *',  NULL, NULL, NOW())
ON CONFLICT (subsystem) DO NOTHING;


-- Backfill `system_pitr.enabled` so switching on the reconciler cannot stop a
-- cluster that is actively backing up.
--
-- This row has existed since migration 0011 and NOTHING ever read it: on
-- production it says enabled=false with last_fired_at NULL, while CNPG has
-- been taking a base backup every night regardless (four in the last four days
-- when this was written). The moment a reconciler starts honouring the row,
-- that false would suspend the ScheduledBackup and silently end Postgres base
-- backups — the exact trap migration 0089 was written for when the mail
-- schedule gained its first real executor.
--
-- Same remedy: a cluster with a SYSTEM target bound is one whose base backups
-- are expected to run, so adopt reality rather than the dormant default. A
-- cluster with no target bound stays disabled, which is also what the
-- reconciler would decide for it anyway.
UPDATE public.backup_schedules
   SET enabled = TRUE,
       updated_at = NOW()
 WHERE subsystem = 'system_pitr'
   AND enabled = FALSE
   AND EXISTS (
     SELECT 1
       FROM public.backup_target_assignments a
       JOIN public.backup_configurations c ON c.id = a.target_id
      WHERE a.backup_class = 'system'
        AND c.enabled = 1
   );


-- ...and clear the cron on the same dormant row, for the same reason.
--
-- Production carries '0 1 * * *' here while the CNPG ScheduledBackup has
-- always run '0 0 3 * * *' (03:00). Enabling the row without this would move
-- the nightly base backup to 01:00 — an unrequested change to when production
-- takes its database backup, produced by a value no operator ever chose and
-- nothing ever applied.
--
-- NULL means "use the manifest default" to the reconciler, and that default is
-- the 03:00 both clusters actually run. An operator who then picks a time gets
-- a value that is honoured for the first time.
UPDATE public.backup_schedules
   SET cron_expression = NULL,
       updated_at = NOW()
 WHERE subsystem = 'system_pitr'
   AND last_fired_at IS NULL;
