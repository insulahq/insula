-- Notification system Phase 1: extend existing notifications table with
-- category + severity + event grouping.
--
-- This is an ADD COLUMN-only migration so backend rollout is safe under HA
-- replicas. The category_id is nullable for the transition window — old
-- callers (notifyUser without a category) still work and we backfill
-- the column from `type` via a synthetic 'legacy.<type>' category seeded by
-- the application boot path. Once all callers are migrated to category-
-- aware events.ts helpers, a follow-up migration will tighten this.
--
-- event_id groups every row produced by a single emit-event call so the
-- delivery log can show "tenant.suspended for tenant X went to in_app+email"
-- as one logical line in the admin UI.
--
-- dedupe_key is opt-in (nullable). When set, a partial unique index enforces
-- "at most one row with this key in the last hour" — the dispatcher uses
-- this to coalesce duplicate emits (e.g. a backup-target reachability
-- watcher firing every minute).

ALTER TABLE notifications
  ADD COLUMN category_id  VARCHAR(64) REFERENCES notification_categories(id) ON DELETE SET NULL,
  ADD COLUMN severity     notification_severity_enum NOT NULL DEFAULT 'info',
  ADD COLUMN event_id     UUID,
  ADD COLUMN dedupe_key   VARCHAR(128),
  ADD COLUMN locale       VARCHAR(8) NOT NULL DEFAULT 'en',
  ADD COLUMN tenant_id    VARCHAR(36);

CREATE INDEX notifications_category_idx ON notifications(category_id);
CREATE INDEX notifications_event_idx    ON notifications(event_id);
CREATE INDEX notifications_tenant_idx   ON notifications(tenant_id) WHERE tenant_id IS NOT NULL;

-- Non-unique lookup index for dedupe-key checks. The Phase-1 dispatcher
-- does not populate dedupe_key (Phase 2 will, alongside an app-side
-- "is there a row with this user_id+dedupe_key in the last hour?"
-- guard before INSERT). A partial unique index here would be a trap:
-- Postgres can't include `now()` in an index predicate, so the
-- constraint would last forever and break legitimate re-emits of the
-- same key after the dedupe window expires.
CREATE INDEX notifications_dedupe_lookup_idx
  ON notifications(user_id, dedupe_key, created_at DESC)
  WHERE dedupe_key IS NOT NULL;
