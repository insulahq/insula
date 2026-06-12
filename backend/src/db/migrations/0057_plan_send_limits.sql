-- R6 PR 1: plan-based email send limits + per-tenant outbound suspension.
--
-- Limits resolve tenant-override -> plan (hosting_plans columns are NOT
-- NULL so every tenant always resolves; the old platform_settings key
-- `email_send_rate_limit_default` is retired by this migration's code).
-- Defaults 50/hour + 100/day were set by the operator (2026-06-12).

ALTER TABLE hosting_plans
  ADD COLUMN IF NOT EXISTS email_hourly_send_limit integer NOT NULL DEFAULT 50;

ALTER TABLE hosting_plans
  ADD COLUMN IF NOT EXISTS email_daily_send_limit integer NOT NULL DEFAULT 100;

-- Per-tenant overrides. Hourly override already exists as
-- tenants.email_send_rate_limit (kept, semantics unchanged: null =
-- inherit). Daily override is new.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS email_send_rate_limit_daily integer;

-- Outbound-mail suspension: narrower than tenant suspension — receiving
-- and webmail keep working, only outbound submission is blocked. This is
-- the manual admin lever for complaint handling (R4 notify-only mode).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS email_outbound_suspended boolean NOT NULL DEFAULT false;
