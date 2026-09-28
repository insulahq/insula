-- ADR-062 R2 — remember what a deployment asked for BEFORE it was re-tiered.
--
-- The migration is reversible per tenant, and "reversible" has to mean
-- restored to the exact prior value, not to a recomputed approximation. The
-- prior request cannot be derived after the fact: it came from the catalog
-- entry's `recommended.cpu` at deploy time, from an operator edit, or from a
-- default that has since changed. Recomputing it would quietly hand a tenant
-- a different reservation than it had, during the operation whose entire
-- purpose is to put things back.
--
-- NULL means "never migrated". A revert clears it back to NULL so a second
-- migration stores a fresh baseline rather than reverting to an older one.
--
-- varchar to match deployments.cpu_request exactly — storing millicores as an
-- integer here would lose the distinction between "0.25" and "250m", and the
-- restore would then rewrite a field the operator never asked to change.
ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS cpu_request_pre_migration varchar(20);

COMMENT ON COLUMN deployments.cpu_request_pre_migration IS
  'ADR-062: exact cpu_request before tier migration. NULL = never migrated. Cleared on revert.';
