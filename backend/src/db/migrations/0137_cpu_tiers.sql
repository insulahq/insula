-- ADR-062 R2 — where a tenant's CPU tier and burst ceiling live.
--
-- A tenant CPU request stops being a core count and becomes a SHARE: the
-- millicore value is chosen in cpu.weight space (5m/30m/100m -> weight 1/2/4),
-- so contention is resolved by ratio instead of by a reservation that neither
-- caps nor guarantees anything. The tenant-wide burst ceiling is what bounds a
-- noisy neighbour; the request no longer pretends to.
--
-- Both are PLAN properties with a per-tenant override — deliberately the same
-- shape as memory, storage, bandwidth and mailboxes, so there is one mental
-- model for "what a plan grants and what this tenant gets instead".
--
-- ★ cpu_limit is NOT reinterpreted, and is not touched here.
-- Despite its name it feeds requests.cpu today (a reservation). Repointing the
-- same number at limits.cpu would silently convert "reserve 1 core, burst
-- without limit" into "burst to 1 core" on clusters nobody on this side can
-- inspect. It stays, read only by legacy mode, and is dropped when the mode
-- flag is.
--
-- ★ Every existing tenant lands in 'legacy' and nothing about its scheduling
-- changes. Migration is a per-tenant panel action with a dry run in front of
-- it, never a flag day: the DEFAULT on the column is what makes an upgrade of
-- an unknown cluster a no-op.
--
-- Replay-safe: every statement is IF NOT EXISTS.

-- safety-reviewed: Postgres has no CREATE TYPE ... IF NOT EXISTS, so this
-- DO/EXCEPTION block is the idiomatic idempotent equivalent. The migration
-- runner dollar-quote-parses it as ONE statement, per db/sql-splitter.ts --
-- only the guard's flattener sees the inner CREATE TYPE in isolation.
DO $$ BEGIN
  CREATE TYPE cpu_tier AS ENUM ('normal', 'high', 'highest');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- safety-reviewed: Postgres has no CREATE TYPE ... IF NOT EXISTS, so this
-- DO/EXCEPTION block is the idiomatic idempotent equivalent. The migration
-- runner dollar-quote-parses it as ONE statement, per db/sql-splitter.ts --
-- only the guard's flattener sees the inner CREATE TYPE in isolation.
DO $$ BEGIN
  CREATE TYPE cpu_scheduling_mode AS ENUM ('legacy', 'tiered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Plan grants. NULL means "not expressed by this plan" and falls through to
-- the derivation in tiers.ts, exactly as a NULL override falls through to the
-- plan. NULL never means unlimited anywhere in this schema.
ALTER TABLE hosting_plans ADD COLUMN IF NOT EXISTS cpu_tier cpu_tier;
ALTER TABLE hosting_plans ADD COLUMN IF NOT EXISTS cpu_burst_cores numeric(6,2);

-- Per-tenant overrides.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cpu_tier_override cpu_tier;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cpu_burst_cores_override numeric(6,2);

-- The per-tenant switch. NOT NULL DEFAULT 'legacy' is the safety property:
-- an existing row cannot come out of this migration in tiered mode.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cpu_scheduling_mode cpu_scheduling_mode NOT NULL DEFAULT 'legacy';

-- When a tenant was migrated, so the panel can show it and an operator can
-- tell a never-migrated tenant from one deliberately reverted.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cpu_migrated_at timestamptz;

COMMENT ON COLUMN tenants.cpu_scheduling_mode IS
  'legacy = requests.cpu from cpu_limit (ADR-062 pre-migration); tiered = requests.cpu from the tier, ceiling from cpu_burst_cores.';
COMMENT ON COLUMN hosting_plans.cpu_burst_cores IS
  'Tenant-wide limits.cpu ceiling in cores. Generous by design: max(1, cpu_limit x 2) at migration, because cpu_limit was never a cap.';
