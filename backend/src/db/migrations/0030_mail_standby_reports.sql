-- migration 0030 — mail-standby per-node freshness reports.
--
-- A5 (2026-05-25) shipped the mail-stack-standby-replicate DaemonSet
-- which POSTs its per-iteration stats to
-- POST /internal/mail/standby-replicate-report. Until 0030 there was
-- no place to store the reports — endpoint returned 404 and the
-- DaemonSet logged "report to platform-api failed (non-fatal)".
--
-- Storage shape: a single JSONB column on system_settings keyed by
-- node hostname. Per-node entries: {sizeBytes, fileCount,
-- durationSeconds, reportedAt}. Standby DaemonSets are bounded by
-- the mail-standby label set (typically 1-2 nodes — secondary +
-- tertiary), so JSONB beats a separate table here.
--
-- The mail-admin Standby panel reads this column to render per-node
-- freshness with age + size + RPO traffic-light. Stale entries (>1h)
-- still display so the operator can see "node X hasn't reported in
-- 2 hours" rather than a silent absence.

ALTER TABLE system_settings
  ADD COLUMN mail_standby_reports jsonb;

COMMENT ON COLUMN system_settings.mail_standby_reports IS
  'Per-node mail-standby-replicate freshness reports. Shape: {nodeName: {sizeBytes, fileCount, durationSeconds, reportedAt}}. Written by /internal/mail/standby-replicate-report; read by admin Standby surface.';
