-- Drop the literal `staging` cluster_nodes seed inserted by 0046.
--
-- Migration 0046 seeded a row named 'staging' (public_ip 89.167.3.56)
-- to retroactively register the original staging cluster's first node.
-- That seed runs on every fresh cluster, leaving a phantom row that
-- never reconciles against any real kubelet — caught on the testing
-- cluster (single-node testing.phoenix-host.net) where it inflated
-- canHostClientWorkloads counts and confused the HA-tier feasibility
-- gate.
--
-- Safe because:
--   * scoped to the exact seed (name AND public_ip), so a real node
--     happens to be named 'staging' on someone's cluster won't be
--     touched.
--   * idempotent — running on a cluster where the row was already
--     pruned by hand is a 0-row delete.
DELETE FROM cluster_nodes
WHERE name = 'staging'
  AND public_ip = '89.167.3.56'::inet;
