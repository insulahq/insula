-- Database backup status: when a database last caused an overdue alert.
--
-- alerted_at belongs to one episode and is cleared when it ends. A database
-- whose backups flap — overdue, backed up, overdue again — opened a new
-- episode, and a new alert to the admins and the tenant, every time.
-- last_alerted_at survives the episode: a database alerted on less than
-- twelve hours ago waits out the rest of that window before it is announced
-- again, and an episode that ends inside the window ends silently.
--
-- Additive: the previous release's API pods never read or write it.
--
-- Replay-safe (IF NOT EXISTS) for the non-transactional runner.

ALTER TABLE database_backup_status
  ADD COLUMN IF NOT EXISTS last_alerted_at timestamptz;
