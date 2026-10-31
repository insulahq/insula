/**
 * What cordoning a node does to mail.
 *
 * A drain evicts tenant pods only, so mail keeps running where it is. But the
 * mail stack recovers by MOVING to one named node — its failover target
 * (secondary, then tertiary), which is also where the standby copy of its data
 * is kept — and a cordoned node takes no new pod. Production: the
 * secondary was cordoned for a drain, the mail node went down, the failover
 * picked the cordoned secondary (fixed in dr-watcher) and mail stayed down for
 * the whole outage. Nothing on the drain modal said the cordon did that.
 *
 * The facts are read once and judged by a pure function.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { usableFailoverTargets } from '../mail-admin/failover-targets.js';

export type MailRole = 'active' | 'secondary' | 'tertiary';

export interface MailRoleOnNode {
  /** This node's part in mail: where it runs now, or a failover target. */
  readonly role: MailRole;
  readonly activeNode: string | null;
  readonly autoFailoverEnabled: boolean;
  readonly failoverThresholdSeconds: number;
  /**
   * Failover targets left once this node is cordoned: configured, not the
   * node mail runs on, Ready and uncordoned. Empty → mail cannot fail over.
   */
  readonly otherFailoverTargets: string[];
  /** This node holds the only standby copy of the mail data (the fast failover path). */
  readonly onlyStandbyCopy: boolean;
}

export interface MailPlacementFacts {
  readonly activeNode: string | null;
  readonly secondaryNode: string | null;
  readonly tertiaryNode: string | null;
  readonly autoFailoverEnabled: boolean;
  readonly failoverThresholdSeconds: number;
}

export interface MailLiveNode {
  readonly metadata?: { readonly name?: string; readonly labels?: Readonly<Record<string, string>> };
  readonly spec?: { readonly unschedulable?: boolean };
  readonly status?: { readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }> };
}

export const MAIL_STANDBY_LABEL = 'insula.host/mail-standby';

/** Pure: this node's mail role, or null when it has none. */
export function mailRoleOnNode(
  node: string,
  facts: MailPlacementFacts,
  liveNodes: readonly MailLiveNode[],
): MailRoleOnNode | null {
  const role: MailRole | null =
    facts.activeNode === node ? 'active'
      : facts.secondaryNode === node ? 'secondary'
        : facts.tertiaryNode === node ? 'tertiary'
          : null;
  if (!role) return null;

  const { usable: otherFailoverTargets } = usableFailoverTargets(
    [facts.secondaryNode, facts.tertiaryNode].filter((c) => c !== node),
    facts.activeNode,
    liveNodes,
  );
  const standby = liveNodes
    .filter((n) => n.metadata?.labels?.[MAIL_STANDBY_LABEL] === 'true')
    .map((n) => n.metadata?.name ?? '');

  return {
    role,
    activeNode: facts.activeNode,
    autoFailoverEnabled: facts.autoFailoverEnabled,
    failoverThresholdSeconds: facts.failoverThresholdSeconds,
    otherFailoverTargets,
    onlyStandbyCopy: standby.length === 1 && standby[0] === node,
  };
}

/** The stored mail placement, or null when there is no settings row. Throws when it cannot be read. */
export async function readMailPlacementFacts(db: Database): Promise<MailPlacementFacts | null> {
  const { systemSettings } = await import('../../db/schema.js');
  const [row] = await db.select({
    active: systemSettings.mailActiveNode,
    primary: systemSettings.mailPrimaryNode,
    secondary: systemSettings.mailSecondaryNode,
    tertiary: systemSettings.mailTertiaryNode,
    auto: systemSettings.mailAutoFailoverEnabled,
    threshold: systemSettings.mailFailoverThresholdSeconds,
  }).from(systemSettings).where(eq(systemSettings.id, 'system'));
  if (!row) return null;
  return {
    activeNode: row.active ?? row.primary ?? null,
    secondaryNode: row.secondary ?? null,
    tertiaryNode: row.tertiary ?? null,
    autoFailoverEnabled: row.auto,
    failoverThresholdSeconds: row.threshold,
  };
}

/**
 * Read the placement and the nodes, then judge. Null when mail is not placed
 * here or the facts cannot be read — a drain must not fail over a notice.
 */
export async function loadMailRoleOnNode(
  k8s: K8sClients,
  db: Database,
  node: string,
): Promise<MailRoleOnNode | null> {
  try {
    const facts = await readMailPlacementFacts(db);
    if (!facts) return null;
    const live = await k8s.core.listNode();
    return mailRoleOnNode(node, facts, (live.items ?? []) as MailLiveNode[]);
  } catch (err) {
    console.warn(`[nodes] mail role for ${node} could not be read:`, (err as Error).message);
    return null;
  }
}
