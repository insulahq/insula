-- Monthly bandwidth (data-transfer) cap: a subscription-plan setting with a
-- per-tenant override, plus month-to-date usage accounting + enforcement flag.
-- Default 100 GB/month on every plan. Effective = override ?? plan ?? 100.

-- Plan-level monthly limit (GB). NOT NULL so every tenant resolves a limit
-- through its plan; per-tenant override is nullable below.
ALTER TABLE hosting_plans ADD COLUMN IF NOT EXISTS bandwidth_gb_limit integer NOT NULL DEFAULT 100;

-- Per-tenant override + month-to-date usage + enforcement state.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bandwidth_limit_override integer;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bandwidth_gb_used numeric(14,4) NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bandwidth_cycle_start timestamp;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bandwidth_capped boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bandwidth_capped_at timestamp;
