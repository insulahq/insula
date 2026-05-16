-- Global currency setting (ISO 4217 code) on system_settings.
-- Drives Intl.NumberFormat across both panels for any monetary
-- amount display (plan prices, tenant overrides, future invoices).
-- The existing `currency_symbol` column predates this and stays
-- in place for now — unused at the API/UI layer; new code should
-- only read/write `currency`.
ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
