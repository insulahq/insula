import ClusterNodes from '@/pages/ClusterNodes';

/**
 * Cluster → Nodes — server/worker role + host-tenant-workloads opt-in.
 * Thin route-wrapper around the existing ClusterNodes panel, which
 * renders its own page header when not embedded.
 */
export default function NodesPage() {
  return <ClusterNodes />;
}
