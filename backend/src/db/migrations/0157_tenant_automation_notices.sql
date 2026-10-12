-- Automatic archive and delete (Platform → Tenant Lifecycle Hooks) learns two
-- things about a single tenant.
--
-- 1. Whether the tenant is kept out of it. An operator who suspends a tenant
--    to hold it — a dispute, a customer who asked for a pause, the operator's
--    own sites — must be able to say "never archive or delete this one by
--    itself" without switching the automation off for everybody.
--
-- 2. Whether the tenant has been told. With a notice period set, the sweep
--    writes to the tenant that many days before it archives or deletes it, and
--    does neither until the date it gave has come. One row per tenant and step:
--    when it was told, and the date it was told. A notice counts only for the
--    suspension (or archive) it was sent in — the sweep compares `told_at` with
--    the tenant's suspended_at / archived_at — so a tenant resumed and
--    suspended again is told again.
--
-- Idempotent. The column has a constant default, so adding it rewrites no row.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "lifecycle_automation_exempt" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "tenant_automation_notices" (
  "tenant_id" varchar(36) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "step" text NOT NULL,
  "told_at" timestamptz NOT NULL DEFAULT now(),
  -- The date the tenant was given: nothing happens to it before.
  "announced_for" timestamptz NOT NULL,
  -- How many deliveries the message came to. 0 = nobody could be told (no user
  -- with an address, or notifications are off); the admins are shown that.
  "reached" integer NOT NULL DEFAULT 0,
  CONSTRAINT "tenant_automation_notices_pkey" PRIMARY KEY ("tenant_id", "step"),
  CONSTRAINT "tenant_automation_notices_step_check" CHECK ("step" IN ('archive', 'delete'))
);
