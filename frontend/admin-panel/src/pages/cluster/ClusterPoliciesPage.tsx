import PlatformStoragePolicyCard from '@/components/PlatformStoragePolicyCard';
import NodeDefaultsCard from '@/components/NodeDefaultsCard';

/**
 * Cluster → Cluster Policies — combined home for the two operator-rare
 * cluster-wide policy knobs:
 *
 *   1. Platform Storage Policy — the HA Mode toggle (Longhorn replica
 *      count, CNPG instance count, stateless Deployment replicas).
 *   2. Node Defaults — image-GC thresholds applied per node.
 *
 * Both were previously hidden under /settings/system (and before that
 * under /nodes-and-storage's "Cluster Settings" tab). Combining them
 * here keeps the once-set policy surface in one routable spot without
 * inflating the sidebar.
 */
export default function ClusterPoliciesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Cluster Policies</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Once-set cluster-wide knobs — HA mode, node-level image garbage collection.
        </p>
      </div>
      <PlatformStoragePolicyCard />
      <NodeDefaultsCard />
    </div>
  );
}
