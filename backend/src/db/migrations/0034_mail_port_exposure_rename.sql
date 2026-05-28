-- 0034_mail_port_exposure_rename.sql
--
-- Rename mail port exposure mode values for the 3-mode redesign (2026-05-28).
--
--   thisNodeOnly   → activeNodeOnly       (renamed for clarity)
--   allServerNodes → allServerNodes       (unchanged value; semantics now
--                                          ALSO include the active node
--                                          when it's worker-role)
--   (NEW)          → assignedMailNodes    (haproxy on operator-chosen
--                                          {primary, secondary, tertiary})
--
-- Existing rows are rewritten in place — no data loss. The column is a
-- free-form varchar(32), not a Postgres enum, so no enum migration
-- needed (validation is on the Zod schema at the API boundary).

UPDATE system_settings
SET mail_port_exposure_mode = 'activeNodeOnly'
WHERE mail_port_exposure_mode = 'thisNodeOnly';

-- Defensive: column is varchar(32) with no CHECK constraint, so a
-- stray value from a direct psql edit or a reverted code path would
-- propagate as a Zod parse failure on every GET /admin/mail/port-
-- exposure (HTTP 503). Map anything we don't recognise back to the
-- default `allServerNodes`. No-op when the column is already one of
-- the valid three values.
UPDATE system_settings
SET mail_port_exposure_mode = 'allServerNodes'
WHERE mail_port_exposure_mode NOT IN ('activeNodeOnly', 'assignedMailNodes', 'allServerNodes');
