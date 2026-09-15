-- Remove the legacy.* notification categories and everything that referenced
-- them.
--
-- These four existed as a fall-through for `notifyUser()`, which wrote a
-- notifications row with a hand-built title and message and reached no
-- template, no email, no push, no preference gate and no delivery audit.
-- Measured on production 2026-09-14: 67 of ~220 in-app rows were legacy.*,
-- and they were the operational tenant-facing events — IMAPSync, email enabled
-- for a domain, mailbox limit, DKIM rotation, mailbox quota. None of them had
-- EVER reached a tenant by email.
--
-- Every caller now dispatches through a real category, `notifyUser` and
-- `notifyUsers` are deleted, and `createNotification` requires a categoryId,
-- so nothing can write a legacy row again.
--
-- Order matters: notification_deliveries.category_id is ON DELETE RESTRICT, so
-- the delivery rows must go before the categories they point at. Those rows
-- are inside the 30-day delivery retention window and would have been reaped
-- on their own schedule regardless.
DELETE FROM notification_deliveries WHERE category_id LIKE 'legacy.%';

-- Historical inbox rows keep their text and become uncategorised rather than
-- being deleted: they are what a user already read, and the 90-day retention
-- removes them on its own schedule. Nulling is the smaller change.
UPDATE notifications SET category_id = NULL WHERE category_id LIKE 'legacy.%';

DELETE FROM notification_templates WHERE category_id LIKE 'legacy.%';
DELETE FROM notification_template_versions WHERE category_id LIKE 'legacy.%';
DELETE FROM user_notification_preferences WHERE category_id LIKE 'legacy.%';
DELETE FROM notification_categories WHERE id LIKE 'legacy.%';
