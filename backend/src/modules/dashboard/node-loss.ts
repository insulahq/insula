/**
 * What losing one node would affect: the dashboard's Failover line.
 *
 * The line named the node with the most CPU as the worst case. That is the
 * node the capacity test removes, but not the one whose loss does the most
 * harm: on production it named a node that had just joined, with no tenant
 * and no part in mail, while another held most tenants and the mail standby.
 * A tenant on local storage keeps its data on one node and stays down until
 * that node is back; mail runs on one node and fails over to another.
 *
 * The facts are read once and judged by a pure function.
 */
import { sql } from 'drizzle-orm';
import type { NodeLoss } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { resolveActiveMailNode } from '../mail-admin/active-node.js';
import {
  MAIL_STANDBY_LABEL,
  mailRoleOnNode,
  readMailPlacementFacts,
  type MailLiveNode,
  type MailPlacementFacts,
} from '../nodes/mail-role.js';

export interface NodeLossFacts {
  /** Every node, with its CPU: the last tie-breaker, as in the capacity test. */
  readonly nodes: ReadonlyArray<{ readonly name: string; readonly cpuTotal: number }>;
  /** One entry per active customer tenant: the nodes it depends on (see loadTenantNodes). */
  readonly tenantNodes: ReadonlyArray<readonly string[]>;
  /** Null when there is no mail placement to judge. */
  readonly mail: MailPlacementFacts | null;
  readonly liveNodes: readonly MailLiveNode[];
}

/** Pure: what losing `node` would affect. */
export function nodeLossOf(node: string, facts: NodeLossFacts): NodeLoss {
  const tenants = facts.tenantNodes.filter((nodes) => nodes.includes(node)).length;
  return { node, tenants, mail: mailPartOf(node, facts) };
}

function mailPartOf(node: string, facts: NodeLossFacts): NodeLoss['mail'] {
  if (!facts.mail) return null;
  const role = mailRoleOnNode(node, facts.mail, facts.liveNodes);
  if (role?.role === 'active') {
    return { role: 'active', staysDown: !role.autoFailoverEnabled || role.otherFailoverTargets.length === 0 };
  }
  if (role) return { role: role.role, staysDown: false };
  const holdsStandby = facts.liveNodes.some(
    (n) => n.metadata?.name === node && n.metadata?.labels?.[MAIL_STANDBY_LABEL] === 'true',
  );
  return holdsStandby ? { role: 'standby', staysDown: false } : null;
}

/** Higher is worse. Mail that cannot fail over ranks above any tenant count (see worstNodeLoss). */
const MAIL_ROLE_WEIGHT: Readonly<Record<NonNullable<NodeLoss['mail']>['role'], number>> = {
  active: 3, secondary: 2, tertiary: 1, standby: 1,
};

/**
 * Pure: the node whose loss would affect the most. Mail that would stay down
 * comes first — it is every mailbox until the node is back. Then the number of
 * tenants, then the node's part in mail, then CPU. Null for no nodes.
 */
export function worstNodeLoss(facts: NodeLossFacts): NodeLoss | null {
  const cpu = new Map(facts.nodes.map((n) => [n.name, n.cpuTotal]));
  const strandsMail = (l: NodeLoss): number => (l.mail?.staysDown ? 1 : 0);
  const mailWeight = (l: NodeLoss): number => (l.mail ? MAIL_ROLE_WEIGHT[l.mail.role] : 0);
  const ranked = facts.nodes
    .map((n) => nodeLossOf(n.name, facts))
    .sort((a, b) => strandsMail(b) - strandsMail(a)
      || b.tenants - a.tenants
      || mailWeight(b) - mailWeight(a)
      || (cpu.get(b.node) ?? 0) - (cpu.get(a.node) ?? 0)
      || a.node.localeCompare(b.node));
  return ranked[0] ?? null;
}

/**
 * The nodes each active customer tenant depends on, from the placement the
 * reconciler rewrites every minute. A local-tier tenant depends on every node
 * holding its workloads, volumes or data: its data has no other copy. An
 * HA-tier tenant survives losing a replica, so only the nodes it runs or has
 * its volume attached on count — losing one of those restarts it elsewhere.
 */
export async function loadTenantNodes(db: Pick<Database, 'execute'>): Promise<string[][]> {
  const placement = await db.execute<{ nodes: string[] | null }>(sql`
    SELECT ARRAY(
             SELECT DISTINCT n
               FROM unnest(CASE WHEN p.storage_tier = 'ha'
                                THEN p.workload_nodes || p.attached_nodes
                                ELSE p.workload_nodes || p.attached_nodes || p.data_nodes
                           END) AS n
           ) AS nodes
      FROM tenant_placement_state p
      JOIN tenants t ON t.id = p.tenant_id
     WHERE t.status = 'active' AND NOT t.is_system
  `);
  return (placement.rows ?? []).map((r) => r.nodes ?? []);
}

/**
 * The stored mail placement, with the node mail runs on resolved the way the
 * DR watcher resolves it — live pod, then its volume, then the stored column —
 * because the column can still name a node mail has left. Read-only.
 */
async function loadMailFacts(db: Database, k8s: K8sClients): Promise<MailPlacementFacts | null> {
  const stored = await readMailPlacementFacts(db);
  if (!stored) return null;
  const { node } = await resolveActiveMailNode(db, k8s.core, { stored: stored.activeNode });
  return { ...stored, activeNode: node ?? stored.activeNode };
}

/**
 * Read the facts: tenant placement, the mail placement and the live nodes.
 * Throws when one cannot be read — the caller drops the line rather than guess.
 */
export async function loadNodeLossFacts(
  db: Database,
  k8s: K8sClients,
  nodes: NodeLossFacts['nodes'],
): Promise<NodeLossFacts> {
  const [tenantNodes, mail, live] = await Promise.all([
    loadTenantNodes(db),
    loadMailFacts(db, k8s),
    k8s.core.listNode(),
  ]);
  return {
    nodes,
    tenantNodes,
    mail,
    liveNodes: ((live as { items?: MailLiveNode[] }).items ?? []),
  };
}
