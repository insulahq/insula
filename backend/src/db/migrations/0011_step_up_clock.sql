-- Per-purpose step-up freshness clock — distinct from last_credential_check_at.
--
-- The original step-up gate (migration 0009) bumps a single timestamp
-- on EVERY successful credential challenge (password login, passkey
-- verify, OIDC login, and the step-up endpoints themselves). That
-- made the freshness window satisfiable by a fresh login alone — so
-- the very first time an operator clicked Terminal after logging in,
-- no explicit step-up was demanded.
--
-- ADR-041 evolved: opening the node terminal for the FIRST time must
-- always require an explicit step-up, regardless of how recently the
-- operator logged in. We track that with a dedicated column. Only
-- the /me/step-up/* endpoints write it; login flows leave it alone.
--
-- NULL = never stepped up — terminal-open requires step-up.
-- Otherwise the same 30-min window applies; subsequent opens inside
-- that window skip the prompt.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_step_up_at" TIMESTAMP;
