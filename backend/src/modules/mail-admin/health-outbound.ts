/**
 * Mail health — can the mail nodes deliver? Outbound TCP 25 from every node
 * mail placement names.
 *
 * The mail server delivers to other mail servers on port 25 from whichever node
 * it runs on, and a hosting provider can block that port on a server where
 * nothing on the node shows it (node-health/outbound-mail.ts). A blocked active
 * node queues all outbound mail; a blocked secondary or tertiary would do the
 * same the moment a failover or a move puts the mail server there — which is
 * exactly when nobody is looking at providers. So the component fails for any
 * of them. 465 and 587 are listed for information; node health judges those.
 *
 * Read from each node's security-probe ConfigMap (data.outboundMail), never by
 * dialling from the API pod: the API pod's node is not the mail node.
 */

import {
  OUTBOUND_MAIL_DELIVERY_PORT,
  type MailHealthOutboundComponent,
  type MailHealthOutboundNode,
  type OutboundMailProbe,
} from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { judgeOutboundMail, readOutboundMailProbes, requiredOutboundPorts } from '../node-health/outbound-mail.js';
import { getMailPlacement } from './placement.js';

const READ_TIMEOUT_MS = 10_000;

export interface MailOutboundPlacement {
  readonly primaryNode: string | null;
  readonly secondaryNode: string | null;
  readonly tertiaryNode: string | null;
  readonly activeNode: string | null;
}

export interface MailOutboundInput {
  readonly placement: MailOutboundPlacement;
  /** Each node's latest probe result, keyed by Node name. */
  readonly probes: ReadonlyMap<string, OutboundMailProbe>;
  readonly now: Date;
}

/** The mail nodes in placement order, each once; the active node last if placement does not name it. */
function mailNodes(p: MailOutboundPlacement): Array<{ node: string; role: MailHealthOutboundNode['role'] }> {
  const out: Array<{ node: string; role: MailHealthOutboundNode['role'] }> = [];
  const seen = new Set<string>();
  const add = (node: string | null, role: MailHealthOutboundNode['role']) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    out.push({ node, role });
  };
  add(p.primaryNode, 'primary');
  add(p.secondaryNode, 'secondary');
  add(p.tertiaryNode, 'tertiary');
  add(p.activeNode, 'active');
  return out;
}

const ROLE_LABEL: Record<MailHealthOutboundNode['role'], string> = {
  primary: 'the primary mail node',
  secondary: 'the secondary mail node',
  tertiary: 'the tertiary mail node',
  active: 'the mail node',
};

export function evaluateOutbound(input: MailOutboundInput): MailHealthOutboundComponent {
  const port = OUTBOUND_MAIL_DELIVERY_PORT;
  const required = requiredOutboundPorts(true);
  const nodes: MailHealthOutboundNode[] = mailNodes(input.placement).map(({ node, role }) => {
    const judged = judgeOutboundMail(input.probes.get(node), { required, now: input.now });
    const delivery = judged?.ports.find((p) => p.port === port);
    return {
      node,
      role,
      active: node === input.placement.activeNode,
      checkedAt: judged?.checkedAt ?? null,
      stale: judged?.stale ?? false,
      ports: judged?.ports ?? [],
      delivery: !judged || judged.stale || !delivery ? 'unknown' : delivery.status,
    };
  });

  const blocked = nodes.filter((n) => n.delivery === 'blocked');
  if (blocked.length > 0) {
    const error = blocked.map((n) => {
      const where = `${n.node} (${ROLE_LABEL[n.role]})`;
      return n.active
        ? `Outbound port ${port} is blocked on ${where}, where the mail server runs: mail to other servers is queued, not delivered.`
        : `Outbound port ${port} is blocked on ${where}: mail would stop going out if the mail server moved there.`;
    }).join(' ') + ' Ask the hosting provider to unblock outbound TCP 25.';
    return { status: 'fail', healthy: false, error, deliveryPort: port, nodes };
  }
  if (nodes.every((n) => n.checkedAt === null)) {
    return { status: 'not_implemented', healthy: true, error: null, deliveryPort: port, nodes };
  }
  return { status: 'ok', healthy: true, error: null, deliveryPort: port, nodes };
}

/**
 * The blocked mail nodes, one line each — the alert's list (health-scheduler
 * componentProbes). Empty unless the component failed on a block.
 */
export function outboundItems(component: unknown): string[] {
  const c = component as { healthy?: boolean; deliveryPort?: number; nodes?: unknown } | null;
  if (!c || c.healthy !== false || !Array.isArray(c.nodes)) return [];
  return (c.nodes as MailHealthOutboundNode[])
    .filter((n) => n.delivery === 'blocked')
    .map((n) => {
      const port = n.ports.find((p) => p.port === c.deliveryPort);
      const where = n.active ? `${n.role}, the mail server runs here` : n.role;
      return `${n.node} (${where}): port ${c.deliveryPort} — ${port?.detail ?? 'no target answered'}`;
    });
}

/** The component; `not_implemented` without a reader, `fail` when the read itself fails. */
export async function probeOutbound(
  read: (() => Promise<MailOutboundInput>) | undefined,
): Promise<MailHealthOutboundComponent> {
  const port = OUTBOUND_MAIL_DELIVERY_PORT;
  if (!read) return { status: 'not_implemented', healthy: true, error: null, deliveryPort: port, nodes: [] };
  let timer: NodeJS.Timeout | undefined;
  try {
    const input = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('reading the outbound mail checks timed out')), READ_TIMEOUT_MS);
      }),
    ]);
    return evaluateOutbound(input);
  } catch (err) {
    const error = `Could not read the mail nodes' outbound mail checks: ${err instanceof Error ? err.message : String(err)}`;
    return { status: 'fail', healthy: false, error, deliveryPort: port, nodes: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface MailOutboundReaderDeps {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly kubeconfigPath: string | undefined;
}

/** The reader both callers of getMailHealth (route + scheduler) pass in. */
export function mailOutboundReader(deps: MailOutboundReaderDeps): () => Promise<MailOutboundInput> {
  return async () => {
    let listError: string | null = null;
    const [placement, probes] = await Promise.all([
      getMailPlacement(deps.db, { kubeconfigPath: deps.kubeconfigPath }),
      readOutboundMailProbes(deps.k8s, (message) => { listError = message; }),
    ]);
    // An unreadable probe list would show every mail node unchecked — and pass.
    if (listError) throw new Error(`listing the security-probe ConfigMaps failed: ${listError}`);
    return {
      placement: {
        primaryNode: placement.primaryNode,
        secondaryNode: placement.secondaryNode,
        tertiaryNode: placement.tertiaryNode,
        activeNode: placement.activeNode,
      },
      probes,
      now: new Date(),
    };
  };
}
