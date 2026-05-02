-- Persist `namespace` on client_lifecycle_transitions so the Phase 5
-- retry scheduler doesn't have to re-derive it from the clients table
-- (which fails for `deleted` transitions because the row is gone).
--
-- Backfill from the clients table for currently-existing clients;
-- transitions for already-deleted clients keep namespace NULL — the
-- retry scheduler treats NULL the same as the empty fallback.

ALTER TABLE client_lifecycle_transitions
  ADD COLUMN namespace VARCHAR(63);

UPDATE client_lifecycle_transitions t
SET namespace = c.kubernetes_namespace
FROM clients c
WHERE c.id = t.client_id
  AND t.namespace IS NULL;
