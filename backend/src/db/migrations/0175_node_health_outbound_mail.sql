-- Node health records each node's outbound mail ports.
--
-- The security-probe on every node now dials TCP 25, 465 and 587 on public
-- mail servers and publishes whether they get out (a provider can block them
-- upstream, where nothing on the node shows it). The node-health reconciler
-- judges the result each tick and keeps it with the row it already writes, so
-- the panel and the summary API show it with the rest of the node's state.
-- NULL = no check reported for the node.
ALTER TABLE node_health_state ADD COLUMN IF NOT EXISTS outbound_mail jsonb;
