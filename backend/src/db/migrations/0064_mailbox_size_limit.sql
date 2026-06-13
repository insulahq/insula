-- Per-plan max mailbox size.
--
-- Adds a plan-level ceiling on an INDIVIDUAL mailbox's size (quota_mb),
-- with an optional per-tenant override, mirroring the existing mailbox
-- COUNT cap (hosting_plans.max_mailboxes / tenants.max_mailboxes_override).
-- The cap defaults the quota of new mailboxes and is enforced on both
-- create and quota edits (mailboxes/service.ts + mailboxes/limit.ts). It
-- does NOT make total mail count against the subscription storage limit —
-- mail storage stays decoupled from hosting_plans.storage_limit.
ALTER TABLE hosting_plans ADD COLUMN IF NOT EXISTS max_mailbox_size_mb INTEGER NOT NULL DEFAULT 1024;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_mailbox_size_mb_override INTEGER;

-- Seeded-plan sizes + display-name retiering. The stable `code` is kept
-- (planCode readers and the hosting_plans_code_unique index depend on it);
-- only the human-facing `name` changes. Final ladder, ascending:
--   Starter   (code starter)  = 1 GiB
--   Premium   (code business) = 2 GiB   [was named "Business"]
--   Ultimate  (code premium)  = 5 GiB   [was named "Premium"]
UPDATE hosting_plans SET max_mailbox_size_mb = 1024                      WHERE code = 'starter';
UPDATE hosting_plans SET max_mailbox_size_mb = 2048, name = 'Premium'    WHERE code = 'business';
UPDATE hosting_plans SET max_mailbox_size_mb = 5120, name = 'Ultimate'   WHERE code = 'premium';
