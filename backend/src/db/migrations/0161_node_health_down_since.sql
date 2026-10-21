-- node_health_state.down_since: when the node left Ready for the outage in
-- progress, NULL while it is Ready.
--
-- The startup notice reports how long a node was down. It measured from the
-- last reconciler tick that observed the node, and the reconciler keeps
-- observing a node while it is down, so a ~21 minute shutdown came back as
-- "~1m 59s". The moment it went down is the Ready condition's own transition
-- time, and that is overwritten when the node comes back, so it has to be
-- remembered here: written by whichever detector sees the node down first
-- (the 30-second down-watch or the reconciler), cleared once it is Ready again.
--
-- Nullable, no backfill: a node down across this upgrade has it filled on the
-- next tick from the Ready condition, which still holds the moment it went down.
ALTER TABLE node_health_state
  ADD COLUMN IF NOT EXISTS down_since TIMESTAMPTZ;
