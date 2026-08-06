-- Node IPv6 visibility (2026-08-06).
--
-- `cluster_nodes.public_ip` holds ONE address, populated from the first
-- `ExternalIP` on the k8s Node object — which is the IPv4. On a dual-stack
-- cluster the node also carries a global IPv6 ExternalIP, and nothing in the
-- platform ever recorded it:
--
--   * The admin panel's node row showed only the v4, so an operator had no way
--     to read the node's IPv6 from the UI — yet `ingress_default_ipv6`, the
--     setting that drives every apex AAAA record, is operator-set and needs
--     exactly that value. The only way to find it was SSH + `ip -6 addr`.
--   * getPlatformIngressIps() already builds a `v6Set` from cluster_nodes and
--     tests each address with `ip.includes(':')` — but since public_ip is
--     always v4, that branch was dead and the node-sourced half of AAAA domain
--     verification never matched anything.
--
-- A second column rather than widening public_ip: `inet` holds either family,
-- but callers overwhelmingly want "the v4" or "the v6" specifically, and a
-- single column would force every one of them to sniff the family (and would
-- silently drop one address on a dual-stack node). Nullable — single-stack
-- clusters and nodes with no global v6 simply leave it NULL, which is the
-- correct answer, not a missing value.
ALTER TABLE "cluster_nodes" ADD COLUMN IF NOT EXISTS "public_ipv6" inet;

COMMENT ON COLUMN "cluster_nodes"."public_ipv6" IS
  'Global IPv6 ExternalIP from the k8s Node object. NULL on single-stack clusters and on dual-stack nodes with no globally-routable v6 (a ULA is never published as an ExternalIP).';
