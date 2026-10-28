-- Subscription application limit.
--
-- hosting_plans.max_applications caps how many applications a tenant may
-- have — catalog apps, custom containers and compose stacks, stopped ones
-- included, deleted ones not (deployments/application-limit.ts). Per-tenant
-- override: tenants.max_applications_override (null = inherit the plan,
-- 0 = none). Until now nothing bounded it but the namespace quota, which
-- refused workloads by CPU arithmetic no tenant could follow.
--
-- The column default (20, the most generous preset) is what an operator's
-- own plans get, so introducing the limit does not lock out a tenant on a
-- plan the presets below do not know. A tenant already above its limit keeps
-- every application it has; it cannot add another.
ALTER TABLE hosting_plans ADD COLUMN IF NOT EXISTS max_applications INTEGER NOT NULL DEFAULT 20;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_applications_override INTEGER;

-- The seeded plans' presets. A no-op on a fresh install (migrate runs before
-- the seed, which inserts the same values).
UPDATE hosting_plans SET max_applications = 2 WHERE code = 'starter';
UPDATE hosting_plans SET max_applications = 5 WHERE code = 'premium';
UPDATE hosting_plans SET max_applications = 20 WHERE code = 'ultimate';

-- Repair: the suspend/archive lifecycle hook used to set EVERY deployment of a
-- tenant to 'stopped', deleted ones included — they came back on the
-- Applications page and would now count against the limit. A row with
-- deleted_at set and status 'stopped' is exactly that: the tenant deleted it,
-- the hook flipped it. (A deleted row revived to running/pending through a
-- side door is running and is left alone.)
UPDATE deployments SET status = 'deleted' WHERE deleted_at IS NOT NULL AND status = 'stopped';
