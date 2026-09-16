-- Remove the two FBL complaint notification categories left behind by 0119.
--
-- Caught on DEV after deploying the retirement: the categories were gone from
-- the seed list, but `seedCategoriesIfMissing` uses ON CONFLICT DO NOTHING —
-- it inserts what is missing and NEVER removes what has been dropped. So both
-- rows survived, still `is_active`, still carrying three templates each, and
-- would have rendered in Notifications -> Sources as live, configurable
-- sources that no code path can ever fire. That is exactly the dead-source
-- problem the notification overhaul set out to remove.
--
-- Each statement is independently replay-safe (the runner is not
-- transactional).

-- 1. Templates. notification_templates.category_id is ON DELETE CASCADE, but
--    delete explicitly so the deactivate-only path below also leaves nothing.
DELETE FROM notification_templates
 WHERE category_id IN ('admin.email_complaint_warning', 'admin.email_complaint_critical');

-- 2. Per-user overrides for a category that no longer exists.
DELETE FROM user_notification_preferences
 WHERE category_id IN ('admin.email_complaint_warning', 'admin.email_complaint_critical');

-- 3. Deactivate FIRST, unconditionally.
--
--    listCategories() filters on is_active, so this alone takes them out of
--    the operator's Sources list. It also means a cluster that cannot take the
--    DELETE below still ends up in the correct user-visible state.
UPDATE notification_categories
   SET is_active = FALSE
 WHERE id IN ('admin.email_complaint_warning', 'admin.email_complaint_critical');

-- 4. Delete the rows, but ONLY where nothing references them.
--
--    notification_deliveries.category_id is ON DELETE RESTRICT, so an
--    unconditional DELETE would ERROR on any cluster that ever fired a
--    complaint notification — and a migration that cannot apply to real data
--    is how a release crash-loops. Clusters with delivery history keep an
--    inactive row (invisible to operators) until retention prunes those
--    deliveries; clusters with none — including production, where the feature
--    never fired — get the row removed now.
DELETE FROM notification_categories c
 WHERE c.id IN ('admin.email_complaint_warning', 'admin.email_complaint_critical')
   AND NOT EXISTS (
     SELECT 1 FROM notification_deliveries d WHERE d.category_id = c.id
   );
