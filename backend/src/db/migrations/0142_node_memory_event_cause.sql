-- node_memory_events.cause — what actually happened, so neither the admin UI
-- nor a notification claims more than is known.
--
-- Why: a tenant nginx OOM-killed at its 32 MiB limit reached admins titled
-- "Tenant evictions (memory pressure)" — nothing was evicted and the node had
-- no memory pressure — and a container that merely exited 137 was listed in
-- the same alert as a possible OOM, with advice to raise the tenant's memory
-- limit. Container OOM kills now carry a cause from the kernel's own counters
-- (the security-probe OOM witness): memory-limit / node-oom / oom /
-- unconfirmed. Evictions carry the resource the kubelet named.
--
-- Values (packages/api-contracts/src/node-health.ts nodeMemoryEventCauseSchema):
--   container-oom: memory-limit, node-oom, oom, unconfirmed
--   pod-evicted:   node-memory-pressure, node-disk-pressure, node-pid-pressure,
--                  pod-storage-limit, other
--   system-oom:    node-oom
ALTER TABLE "node_memory_events" ADD COLUMN IF NOT EXISTS "cause" varchar(32);

ALTER TABLE "node_memory_events" DROP CONSTRAINT IF EXISTS "node_memory_events_cause_check";
-- NOT VALID: binds every new write without scanning existing rows. The
-- backfill below gives each existing row an allowed value anyway (its CASE
-- ends in ELSE 'other'), so nothing here can abort the migration.
ALTER TABLE "node_memory_events"
  ADD CONSTRAINT "node_memory_events_cause_check"
  CHECK ("cause" IS NULL OR "cause" IN (
    'memory-limit', 'node-oom', 'oom', 'unconfirmed',
    'node-memory-pressure', 'node-disk-pressure', 'node-pid-pressure',
    'pod-storage-limit', 'other'
  )) NOT VALID;

-- Backfill the 30-day window from what the old code wrote. Container kills can
-- only be split by the kubelet's word (the witness did not exist), so they
-- become 'oom' or 'unconfirmed' — never 'memory-limit'. Evictions are
-- classified from the kubelet's own message, exactly as the new code does
-- (memory-events.ts classifyEviction).
UPDATE "node_memory_events" SET "cause" = CASE
  WHEN "kind" = 'system-oom' THEN 'node-oom'
  WHEN "kind" = 'container-oom' AND "message" LIKE '%cause unconfirmed%' THEN 'unconfirmed'
  WHEN "kind" = 'container-oom' THEN 'oom'
  WHEN "message" ILIKE '%low on resource: memory%' OR "message" LIKE '%MemoryPressure%' THEN 'node-memory-pressure'
  WHEN "message" ILIKE '%low on resource: ephemeral-storage%' OR "message" ILIKE '%low on resource: inodes%'
    OR "message" LIKE '%DiskPressure%' THEN 'node-disk-pressure'
  WHEN "message" ILIKE '%low on resource: pids%' OR "message" LIKE '%PIDPressure%' THEN 'node-pid-pressure'
  WHEN "message" ILIKE '%ephemeral local storage usage exceeds%'
    OR "message" ILIKE '%exceeded its local ephemeral storage limit%'
    OR "message" ILIKE '%Usage of EmptyDir volume%exceeds the limit%' THEN 'pod-storage-limit'
  ELSE 'other'
END
WHERE "cause" IS NULL;

-- Category rows are insert-only at boot (seedCategoriesIfMissing), so the new
-- wording of existing categories has to land here. Operators cannot edit these
-- two columns, so there is nothing of theirs to preserve.
UPDATE "notification_categories" SET
  "display_name" = 'Node out of memory / SYSTEM pod evicted',
  "description" = 'The node ran out of memory (kernel SystemOOM), or the kubelet evicted a SYSTEM pod under node pressure (memory, disk or PIDs). The eviction design takes tenant pods first, so either is abnormal. Container OOM kills are reported separately (Tenant workload OOM-killed / Platform workload OOM-killed).'
WHERE "id" = 'admin.node_memory_event_critical';

UPDATE "notification_categories" SET
  "display_name" = 'Tenant pods evicted',
  "description" = 'The kubelet evicted tenant pods: under node pressure (memory, disk or PIDs - the designed backpressure), or because a pod exceeded its own ephemeral-storage limit. The notification names which. Container OOM kills are reported as Tenant workload OOM-killed, never as evictions.'
WHERE "id" = 'admin.node_memory_event_warning';

UPDATE "notification_categories" SET
  "description" = 'A tenant container was killed by the kernel out-of-memory killer - at its own memory limit, or because the node ran out of memory; the notification says which, from the kernel''s own counters. A SIGKILL (exit 137) the platform could not confirm is reported here too, worded as unconfirmed; one the kernel shows was not memory is not reported.'
WHERE "id" = 'admin.tenant_pod_oom';
