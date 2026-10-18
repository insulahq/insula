-- admin.tenant_workloads_down: reach the operator's bell.
--
-- It shipped as class `availability`, which is the platform's OWN
-- reachability and routes around the panel, so its stored default_channels
-- are {email, ntfy}: on production a tenant left FAILED by the
-- auto-heal was announced by push and by an email queued behind a mail
-- outage, and nothing in the panel. The class is now `incident`
-- (in_app + email + ntfy). The category seeder never overwrites an existing
-- row (default_channels is operator-editable), so a database that already
-- seeded the old value keeps it without this.
--
-- Touches ONLY that exact first-seed value: an operator who edited the
-- channels since keeps their choice, and a fresh install (no row yet) is a
-- no-op — the seeder inserts the right value after migrations run.
UPDATE "notification_categories"
   SET "default_channels" = ARRAY['in_app', 'email', 'ntfy']::text[],
       "updated_at" = now()
 WHERE "id" = 'admin.tenant_workloads_down'
   AND "default_channels" = ARRAY['email', 'ntfy']::text[];
