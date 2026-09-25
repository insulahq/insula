-- Tenant workload availability as an EPISODE, plus the auto-heal audit trail.
--
-- What was wrong
-- --------------
-- Nothing in the platform watched whether a tenant's workloads were actually
-- RUNNING. On 2026-09-25 a production tenant sat with all four Deployments at
-- `spec.replicas=1` and `availableReplicas=0` for 18h38m — 571 consecutive
-- kubelet `MountDevice failed … globalmount: file exists` rejections after a
-- host I/O stall shut its XFS log down — and every existing check passed:
--
--   * namespace-integrity audits only MISSING objects; the namespace, PVC,
--     ResourceQuota and NetworkPolicy were all present.
--   * the PVC was Bound and the Longhorn volume `attached/healthy`.
--   * the node was Ready, nothing was OOM-killed, no volume was full.
--   * the whole storage-lifecycle module emitted no notifications at all.
--
-- A tenant can therefore be 100% down while every component reports healthy.
-- This table is the missing observation, and the thing both dashboards read so
-- the two panels cannot disagree about whether a tenant is up.
--
-- The second failure it closes
-- ---------------------------
-- `unquiesce` verified its WRITE, not the OUTCOME: a `/scale` PATCH returning
-- 200 is not a running pod. A ResourceQuota rejection happens when the
-- ReplicaSet creates the pod, not when the Deployment is scaled — and a
-- terminating pod still counts against the quota, so restoring a tenant that
-- sits near its memory ceiling routinely fails AFTER the scale call succeeded.
-- unquiesce then cleared the quiesce-hold annotation, which is the ONLY handle
-- quiesce-watchdog Leg B has. Op terminal + hold gone = a tenant left down with
-- no marker any recovery path could see.
--
-- The shape used here
-- -------------------
-- One row per (tenant, workload) — `reason` and the replica counts are COLUMNS,
-- so a cause that changes mid-outage is a transition inside one episode rather
-- than a second everlasting row that can never clear. Modelled on
-- `tenant_saturation_events` (claim via ON CONFLICT, hysteresis, cleared rows
-- as a short audit tail).
--
-- `first_seen_at` IS the hysteresis: a row is written on first observation but
-- neither the healer nor the dashboards act until the condition has persisted
-- past the grace window. A rollout, an image pull and a node reboot all look
-- like "down" for a few seconds and none of them is a fault.
--
-- `heal_attempts` / `last_heal_error` are why the admin alert can say whether
-- auto-healing was TRIED and failed, versus never ran. An alert that cannot
-- tell those apart sends the operator to look in the wrong place.
--
-- Every write is a single guarded statement: the reconciler runs on every api
-- replica with no lease, so each claim re-checks the state it decided on and
-- exactly one replica wins.

CREATE TABLE IF NOT EXISTS tenant_workload_health_events (
  tenant_id         varchar(36)  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Deployment name. Namespaces are single-tenant, so (tenant, name) is unique.
  workload          varchar(253) NOT NULL,
  namespace         varchar(63)  NOT NULL,
  desired_replicas  integer      NOT NULL,
  available_replicas integer     NOT NULL DEFAULT 0,
  -- Short slug the UI renders and the healer branches on:
  -- volume_attach | quota_rejected | unschedulable | image | crash | unknown
  reason            varchar(32)  NOT NULL DEFAULT 'unknown',
  -- The kubelet/ReplicaSet message the reason was derived from, truncated.
  detail            text,
  first_seen_at     timestamptz  NOT NULL DEFAULT now(),
  last_seen_at      timestamptz  NOT NULL DEFAULT now(),
  -- Auto-heal bookkeeping.
  heal_attempts     integer      NOT NULL DEFAULT 0,
  last_heal_at      timestamptz,
  last_heal_error   text,
  -- Set when a heal attempt was followed by the workload coming back.
  healed_at         timestamptz,
  -- Admin alert ladder (mirrors tenant_saturation_events).
  last_notified_at  timestamptz,
  notify_count      integer      NOT NULL DEFAULT 0,
  -- Set when the workload is observed available again, however it recovered.
  cleared_at        timestamptz,
  PRIMARY KEY (tenant_id, workload)
);

-- The reconciler and both dashboards read OPEN episodes only; cleared rows are
-- a short audit tail that the reconciler garbage-collects.
CREATE INDEX IF NOT EXISTS tenant_workload_health_open_idx
  ON tenant_workload_health_events (tenant_id)
  WHERE cleared_at IS NULL;

-- Leg C sweeps by age across all tenants, so it needs the open set ordered by
-- when the outage started, not per tenant.
CREATE INDEX IF NOT EXISTS tenant_workload_health_first_seen_idx
  ON tenant_workload_health_events (first_seen_at)
  WHERE cleared_at IS NULL;
