-- Tenant placement: where a tenant actually runs and holds its data, against
-- its primary node, and the storage failovers that moved it.
--
-- Why: on a two-node production cluster a 16-second storage stall made
-- Longhorn salvage two tenants' volumes and delete their pods. The pods came
-- back on the OTHER node, data locality copied each volume across, and nothing
-- told the operator — the tenants were simply no longer where the platform
-- said they were (`tenants.node_name`). Backup pods had moved four more
-- tenants' data the same way, silently.
--
-- tenant_placement_state
--   One row per tenant, rewritten by the placement reconciler every minute
--   from one cluster read for the whole fleet. `status`:
--     placed     every workload, attached volume and data replica is on the
--                primary node (HA tier: workloads on it, and a replica on it)
--     misplaced  something is elsewhere — `actual_nodes` says where
--     unpinned   the tenant has no primary node, so nothing to compare
--     unknown    the cluster read was incomplete; the previous facts are kept
--   `misplaced_since` survives across ticks while the tenant stays misplaced
--   and clears when it is back; `notified_at` claims the one notification per
--   misplacement episode across replicas (NULL = not yet sent).
--
-- tenant_storage_failovers
--   One row per Longhorn salvage of a tenant volume, keyed by the volume and
--   Longhorn's `status.remountRequestedAt` — the same salvage seen by two
--   replicas or on every tick inserts once (ON CONFLICT DO NOTHING), which is
--   also what claims its notification. `nodes_before` is where the tenant was
--   on the previous tick, `nodes_after` where it is when the salvage is first
--   seen (possibly empty while its pods restart).
--
-- New tables only; no existing writer is bound. Replay-safe: IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "tenant_placement_state" (
  "tenant_id" varchar(36) PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "status" varchar(16) NOT NULL,
  "primary_node" varchar(253),
  "storage_tier" varchar(8) NOT NULL DEFAULT 'local',
  "workload_nodes" text[] NOT NULL DEFAULT '{}',
  "attached_nodes" text[] NOT NULL DEFAULT '{}',
  "data_nodes" text[] NOT NULL DEFAULT '{}',
  "actual_nodes" text[] NOT NULL DEFAULT '{}',
  "reasons" text[] NOT NULL DEFAULT '{}',
  "misplaced_since" timestamptz,
  "notified_at" timestamptz,
  "checked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_placement_state_status_check"
    CHECK ("status" IN ('placed', 'misplaced', 'unpinned', 'unknown'))
);

CREATE INDEX IF NOT EXISTS "tenant_placement_state_misplaced_idx"
  ON "tenant_placement_state" ("tenant_id") WHERE "status" = 'misplaced';

CREATE TABLE IF NOT EXISTS "tenant_storage_failovers" (
  "id" varchar(36) PRIMARY KEY,
  "tenant_id" varchar(36) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "volume_name" varchar(253) NOT NULL,
  "pvc_name" varchar(253),
  "remount_requested_at" timestamptz NOT NULL,
  "nodes_before" text[] NOT NULL DEFAULT '{}',
  "nodes_after" text[] NOT NULL DEFAULT '{}',
  "detected_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_storage_failovers_event_unique" UNIQUE ("volume_name", "remount_requested_at")
);

CREATE INDEX IF NOT EXISTS "tenant_storage_failovers_tenant_idx"
  ON "tenant_storage_failovers" ("tenant_id", "remount_requested_at" DESC);

COMMENT ON TABLE "tenant_placement_state" IS
  'Per-tenant actual placement vs primary node (tenants.node_name), rewritten each minute by the placement reconciler.';
COMMENT ON TABLE "tenant_storage_failovers" IS
  'Longhorn salvages of tenant volumes (status.remountRequestedAt), one row per event.';
