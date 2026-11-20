-- Tenant placement: the nodes where Longhorn is building a spare copy.
--
-- tenant_placement_state.spare_copy_nodes — nodes where Longhorn builds a copy
-- of a tenant's data that it deletes once built: the tenant runs on one node,
-- its volume is attached there and a full copy is there, and another copy is
-- being built (or created and waiting) elsewhere. That happens when the node
-- drops out of the cluster for a few seconds. Such a copy used to count as the
-- tenant's data being elsewhere, and after ten minutes sent "Not on its
-- primary node" about a tenant that was where it belonged. It is now left out
-- of data_nodes and of the verdict, and kept here for the Placement card.
-- Empty when there is none.
--
-- Additive: the previous release's API pods never read or write it, and the
-- default fills the rows they write meanwhile.
--
-- Replay-safe (IF NOT EXISTS) for the non-transactional runner.

ALTER TABLE tenant_placement_state
  ADD COLUMN IF NOT EXISTS spare_copy_nodes text[] NOT NULL DEFAULT '{}';
