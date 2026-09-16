-- Escalation marker for unacknowledged action notifications.
--
-- An Action-class notification says the recipient must do something or the
-- situation degrades. Until now, one that was never read simply sat there: the
-- platform had no way to tell "told and handled" from "told and ignored", so a
-- tenant who never opened their panel and a tenant who fixed the problem
-- looked identical.
--
-- `escalated_at` makes escalation happen exactly ONCE per notification. Without
-- it the scheduler would re-escalate every tick, which is how an escalation
-- becomes the noise it was meant to cut through.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

-- The scheduler's scan: unread, never escalated, older than the deadline.
-- Partial index because the matching set is tiny and the table is not.
CREATE INDEX IF NOT EXISTS notifications_escalation_idx
  ON notifications (created_at)
  WHERE is_read = 0 AND escalated_at IS NULL;
