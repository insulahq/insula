import type { AdminDashboardLive, NodeLoss } from '@insula/api-contracts';
import NodeName from '@/components/nodes/NodeName';

type Cluster = NonNullable<AdminDashboardLive['cluster']['data']>;

/**
 * What losing `loss.node` would affect, as the parts of one phrase:
 * ["23 tenants", "mail standby"]. Empty when nothing depends on it.
 */
export function nodeLossParts(loss: NodeLoss): string[] {
  const parts: string[] = [];
  if (loss.tenants > 0) parts.push(`${loss.tenants} tenant${loss.tenants === 1 ? '' : 's'}`);
  if (loss.mail?.role === 'active') parts.push(loss.mail.staysDown ? 'all mail (no failover)' : 'mail until it fails over');
  else if (loss.mail) parts.push(`mail ${loss.mail.role}`);
  return parts;
}

/**
 * The dashboard's Failover line. Whether the cluster survives is the capacity
 * test (the other nodes have room for the largest one's requests); the worst
 * case is the node whose loss would affect the most — tenants and mail that
 * depend on it — which is often not the largest.
 */
export default function FailoverLine({ cluster }: { cluster: Cluster }) {
  const loss = cluster.worstNodeLoss;
  const parts = loss ? nodeLossParts(loss) : [];
  return (
    <div
      className={`mt-3 rounded-xl border p-3 text-sm ${
        cluster.survivesSingleNodeLoss
          ? 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
          : 'border-amber-500 bg-amber-50 dark:bg-amber-950/40'
      }`}
      data-testid="failover-line"
    >
      <span className="mr-2 font-mono text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Failover</span>
      {cluster.nodeCount <= 1 ? (
        <span className="text-gray-700 dark:text-gray-300">
          <b>No redundancy.</b> A single node carries every workload — losing it is a full outage.
        </span>
      ) : cluster.survivesSingleNodeLoss ? (
        <span className="text-gray-700 dark:text-gray-300">
          <b>Survives losing any one node.</b>
          {loss && parts.length > 0 ? (
            <> Worst case is <NodeName name={loss.node} /> ({parts.join(' + ')} would be affected).</>
          ) : loss ? (
            <> No tenant or mail depends on a single node.</>
          ) : null}
        </span>
      ) : (
        <span className="text-amber-800 dark:text-amber-200">
          <b>Would not survive losing <NodeName name={cluster.worstNode} />.</b> Its requests do not fit on the rest.
          {loss && parts.length > 0 ? (
            <> Losing <NodeName name={loss.node} /> would affect {parts.join(' + ')}.</>
          ) : null}
        </span>
      )}
    </div>
  );
}
