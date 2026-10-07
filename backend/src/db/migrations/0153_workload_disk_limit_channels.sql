-- tenant.workload_disk_limit (R37): fix the stored channels of a category
-- whose first seed had the wrong class.
--
-- 0152's release seeded it as class `availability`, which routes around the
-- panel (out-of-band only) and so stored default_channels = {email}: the
-- tenant got no in-app notice, the channel they actually read. The class is
-- now `action` (in_app + email). The category seeder never overwrites an
-- existing row (default_channels is operator-editable), so a database that
-- already seeded the wrong value keeps it without this.
--
-- Touches ONLY that exact first-seed value: an operator who edited the
-- channels since keeps their choice, and a fresh install (no row yet) is a
-- no-op — the seeder inserts the right value after migrations run.
UPDATE "notification_categories"
   SET "default_channels" = ARRAY['in_app', 'email']::text[],
       "updated_at" = now()
 WHERE "id" = 'tenant.workload_disk_limit'
   AND "default_channels" = ARRAY['email']::text[];
