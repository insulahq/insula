-- The cluster's own pod and service networks are not proxies. The
-- trusted-proxies reconciler recorded them as 'bootstrap' rows, and every row
-- reaches Traefik's forwardedHeaders.trustedIPs: where the value parsed
-- (single-stack clusters) Traefik believed X-Forwarded-For from any pod,
-- tenant workloads included — past CrowdSec, the WAF's trusted IPs and the
-- login rate limit — while bootstrap.sh pins Traefik's trust to loopback,
-- Traefik being the perimeter. The panels already trust every private range
-- (the built-in 'system' ranges), so these rows gave them nothing. A
-- dual-stack value ("10.42.0.0/16,fd42:42::/56") never parsed, so dual-stack
-- clusters have none to remove. The reconciler no longer writes them
-- (modules/cluster-trusted-proxies/reconciler.ts), and an operator row is not
-- touched.
--
-- One statement, under the table's lock: during a rolling update an older API
-- replica still inserts 'bootstrap' rows every 5 minutes, and one landing
-- between the DELETE and the new CHECK would fail the CHECK's validation.
-- Under the lock it waits, then fails the new CHECK itself (the old reconciler
-- logs that as non-fatal).
DO $$
BEGIN
  LOCK TABLE cluster_trusted_proxy_ranges IN ACCESS EXCLUSIVE MODE;
  DELETE FROM cluster_trusted_proxy_ranges WHERE source = 'bootstrap';
  ALTER TABLE cluster_trusted_proxy_ranges DROP CONSTRAINT IF EXISTS cluster_trusted_proxy_ranges_source_check;
  -- safety-reviewed: validated under ACCESS EXCLUSIVE right after the DELETE, so the only rows left are 'operator' ('system' is never stored).
  ALTER TABLE cluster_trusted_proxy_ranges ADD CONSTRAINT cluster_trusted_proxy_ranges_source_check
    CHECK (source IN ('system', 'operator'));
END
$$;
