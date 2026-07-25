-- Extend node_memory_events.kind with 'container-oom' (2026-07-25):
-- containers OOM-killed at their cgroup limit, detected from
-- containerStatuses lastState/state.terminated. Needed because both
-- kubelet SystemOOM events and cadvisor's container_oom_events_total ride
-- the kmsg oomparser (observed permanently broken on a live node), and the
-- per-container metric series is torn down before the 60s scrape can
-- capture a short-lived kill — container status is the durable,
-- containerd-sourced signal.
ALTER TABLE "node_memory_events"
  DROP CONSTRAINT IF EXISTS "node_memory_events_kind_check";
ALTER TABLE "node_memory_events"
  ADD CONSTRAINT "node_memory_events_kind_check"
  CHECK ("kind" IN ('system-oom', 'pod-evicted', 'container-oom'));
