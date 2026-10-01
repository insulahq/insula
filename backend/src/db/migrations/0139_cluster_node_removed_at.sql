-- Node lifecycle notifications: "joined the cluster" / "removed from the cluster".
--
-- The node-sync reconciler (modules/nodes/k8s-sync.ts) already keeps every
-- Kubernetes Node in `cluster_nodes`, and deliberately does NOT delete the row
-- when the Node disappears: the panel shows it as an orphan so the operator can
-- review it and clean up its residue (Longhorn node CR, mail placement).
--
-- That is exactly why removal needs its own column. With the row kept, "absent
-- from the API" is true on every 60-second tick for as long as the orphan
-- lingers; announcing the removal exactly once — across platform-api replicas
-- and restarts — needs a persisted "already announced" marker, claimed with
-- `UPDATE … SET removed_at = NOW() WHERE removed_at IS NULL RETURNING`.
--
--   NULL      the node is (as far as we last knew) registered with Kubernetes.
--   NOT NULL  the moment its absence from a successful, non-empty Node list was
--             first recorded. Cleared again — and announced as a re-join — if a
--             Node by that name registers later.
--
-- Nullable with no default: every existing row is a node we have not seen
-- leave, which is the correct starting state. Rows for nodes that were already
-- gone before this migration are recognised at runtime by their stale
-- last_seen_at and recorded WITHOUT a notification (see nodes/lifecycle.ts).
--
-- Replay-safe: IF NOT EXISTS.
ALTER TABLE "cluster_nodes" ADD COLUMN IF NOT EXISTS "removed_at" timestamp with time zone;

COMMENT ON COLUMN "cluster_nodes"."removed_at" IS
  'When the node was first found missing from a successful Kubernetes Node list (removal announced once). NULL while the node is registered; cleared when a node by this name re-registers.';
