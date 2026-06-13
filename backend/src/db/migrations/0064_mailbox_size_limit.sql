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

-- Retier + RENAME the seeded plans so name AND code agree, ascending:
--   starter  / Starter  / 1 GiB
--   premium  / Premium  / 2 GiB   (was code 'business', name "Business")
--   ultimate / Ultimate / 5 GiB   (was code 'premium',  name "Premium")
--
-- Safe because tenants reference plans by planId (UUID FK), not by code.
-- ORDER MATTERS: hosting_plans.code is UNIQUE, so free up 'premium' before
-- reusing it — rename old 'premium' -> 'ultimate' first, then 'business' ->
-- 'premium'. On a FRESH install this is a no-op: migrate runs before seed
-- (docker-entrypoint.sh), so hosting_plans is empty here and seed then
-- inserts the final-state rows directly.
UPDATE hosting_plans SET max_mailbox_size_mb = 1024 WHERE code = 'starter';
UPDATE hosting_plans SET code = 'ultimate', name = 'Ultimate', max_mailbox_size_mb = 5120 WHERE code = 'premium';
UPDATE hosting_plans SET code = 'premium',  name = 'Premium',  max_mailbox_size_mb = 2048 WHERE code = 'business';
