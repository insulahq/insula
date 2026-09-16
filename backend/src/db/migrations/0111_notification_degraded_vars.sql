-- Record which template variables were absent at render time.
--
-- Before this, a missing variable either threw (delivery silently marked
-- `skipped`, no alert, no retry) or rendered '' inside an {{#if}} (the fact
-- vanished from the message with no trace at all). Both outcomes were
-- invisible: `subscription.renewed` lost 16 emails and 16 in-app dates to one
-- name mismatch and nothing in the system reported it.
--
-- The delivery path now degrades instead of dropping, and records what it had
-- to degrade. An empty array is the healthy case; a non-empty one is a
-- reportable defect that the admin delivery log can filter on.
ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS degraded_vars JSONB;

-- Partial index: only degraded rows are ever queried by this predicate, and
-- they are the rare case. A full index would be almost entirely dead weight
-- on a table that takes one row per recipient per channel.
CREATE INDEX IF NOT EXISTS notification_deliveries_degraded_idx
  ON notification_deliveries ((degraded_vars IS NOT NULL))
  WHERE degraded_vars IS NOT NULL;
