-- Retire `security.suspicious_activity`.
--
-- Operator decision 2026-09-16. It had templates on every channel and its
-- emitter, `notifyTenantSuspiciousActivity`, was never called from anywhere —
-- because nothing on the platform defines "suspicious". Shipping a detector
-- means choosing a security policy (is a new source IP suspicious? a new
-- user-agent? a new country?), and a wrong choice either cries wolf at every
-- coffee-shop login or stays silent through a real takeover. Better no source
-- than a live-looking one that can never fire.
--
-- Same shape as 0120: each statement independently replay-safe, because the
-- migration runner is not transactional, and the DELETE is guarded because
-- notification_deliveries.category_id is ON DELETE RESTRICT.

DELETE FROM notification_templates
 WHERE category_id = 'security.suspicious_activity';

DELETE FROM user_notification_preferences
 WHERE category_id = 'security.suspicious_activity';

-- Deactivate FIRST and unconditionally: listCategories() filters on
-- is_active, so this alone takes it out of the operator's Sources list even on
-- a cluster where the DELETE below cannot apply.
UPDATE notification_categories
   SET is_active = FALSE
 WHERE id = 'security.suspicious_activity';

DELETE FROM notification_categories c
 WHERE c.id = 'security.suspicious_activity'
   AND NOT EXISTS (
     SELECT 1 FROM notification_deliveries d WHERE d.category_id = c.id
   );
