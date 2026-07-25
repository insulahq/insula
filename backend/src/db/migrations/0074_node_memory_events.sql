-- Node memory events (operator decision 2026-07-25): distinct kernel
-- SystemOOM + kubelet pod-eviction events recorded by the node-health
-- reconciler for the admin UI and categorized admin notifications.
-- dedupe_key = k8s event uid + aggregation count (one row per occurrence
-- even when the API aggregates repeats). 30-day retention enforced by the
-- reconciler tick.
CREATE TABLE IF NOT EXISTS "node_memory_events" (
  "id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  "dedupe_key" text NOT NULL,
  "kind" varchar(16) NOT NULL CHECK ("kind" IN ('system-oom', 'pod-evicted')),
  "node_name" text NOT NULL,
  "namespace" text,
  "pod_name" text,
  "system_workload" boolean NOT NULL DEFAULT false,
  "message" text NOT NULL DEFAULT '',
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "node_memory_events_dedupe_key_unique" UNIQUE ("dedupe_key")
);

-- The UI reads the recent window ordered by occurrence.
CREATE INDEX IF NOT EXISTS "node_memory_events_occurred_at_idx"
  ON "node_memory_events" ("occurred_at" DESC);
