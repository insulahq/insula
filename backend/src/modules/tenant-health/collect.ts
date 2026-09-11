/**
 * Tenant health — cluster + DB fact collection.
 *
 * Deliberately O(1) API calls regardless of tenant count: four cluster LISTs
 * and two queries serve the whole fleet. A per-tenant loop of cluster reads
 * would make the outage banner itself a load problem on a 100-tenant cluster,
 * at exactly the moment the cluster is already unhealthy.
 *
 * Every cluster read is wrapped: a partial failure sets `readError` so the
 * computation reports `unknown` rather than an empty (and falsely reassuring)
 * result. See service.ts for why an empty list must never imply "all fine".
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, mailboxes, systemSettings } from '../../db/schema.js';
import type { NodeFact, PodFact, ReplicaFact, TenantFact, VolumeFact } from './service.js';

const NODE_ROLE_LABEL = 'insula.host/node-role';
const INGRESS_MODE_LABEL = 'insula.host/ingress-mode';

/**
 * The node's public addresses, one per family.
 *
 * Per-family on purpose: a dual-stack node carries two InternalIPs and often
 * two ExternalIPs, so a bare `.find(ExternalIP)` returns whichever k3s listed
 * first (always the v4) and the node's IPv6 goes missing — the same bug
 * k8s-sync already documents. v4 keeps the ExternalIP-then-InternalIP
 * fallback, because on a single-NIC cloud VPS the InternalIP IS the public
 * address.
 */
function publicAddresses(node: RawNode): string[] {
  const addrs = node.status?.addresses ?? [];
  const isV6 = (a: { address?: string }) => (a.address ?? '').includes(':');
  const pick = (type: string, v6: boolean) =>
    addrs.find((a) => a.type === type && isV6(a) === v6)?.address ?? null;
  return [
    pick('ExternalIP', false) ?? pick('InternalIP', false),
    pick('ExternalIP', true) ?? pick('InternalIP', true),
  ].filter((a): a is string => !!a);
}

interface RawNode {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: {
    conditions?: Array<{ type?: string; status?: string; lastTransitionTime?: string }>;
    addresses?: Array<{ type?: string; address?: string }>;
  };
}
interface RawPod {
  metadata?: { namespace?: string; name?: string };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string }>;
  };
}
interface LhReplica {
  spec?: { volumeName?: string; nodeID?: string };
}
interface LhVolume {
  metadata?: { name?: string };
  status?: {
    robustness?: string;
    kubernetesStatus?: { namespace?: string; pvcName?: string };
  };
}

export interface CollectedFacts {
  readonly nodes: NodeFact[];
  readonly pods: PodFact[];
  readonly replicas: ReplicaFact[];
  readonly volumes: VolumeFact[];
  readonly tenants: TenantFact[];
  readonly mailActiveNode: string | null;
  readonly readError: string | null;
}

/** Only `Ready=True` counts. A dead node reports `Unknown`, not `False`. */
function nodeIsReady(node: RawNode): boolean {
  const c = (node.status?.conditions ?? []).find((x) => x.type === 'Ready');
  return c?.status === 'True';
}

function readyTransition(node: RawNode): string | null {
  const c = (node.status?.conditions ?? []).find((x) => x.type === 'Ready');
  return c?.lastTransitionTime ?? null;
}

function podIsReady(pod: RawPod): boolean {
  const c = (pod.status?.conditions ?? []).find((x) => x.type === 'Ready');
  return c?.status === 'True';
}

export async function collectFacts(
  db: Database,
  k8s: K8sClients,
): Promise<CollectedFacts> {
  const errors: string[] = [];
  const guard = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message ?? 'read failed'}`);
      return fallback;
    }
  };

  const [nodeResp, podResp, replicaResp, volumeResp] = await Promise.all([
    guard('nodes', () => k8s.core.listNode() as Promise<{ items?: RawNode[] }>, { items: [] }),
    guard(
      'pods',
      () => k8s.core.listPodForAllNamespaces({}) as Promise<{ items?: RawPod[] }>,
      { items: [] },
    ),
    guard(
      'longhorn replicas',
      () => k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'replicas',
      } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as Promise<{ items?: LhReplica[] }>,
      { items: [] },
    ),
    guard(
      'longhorn volumes',
      () => k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
      } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as Promise<{ items?: LhVolume[] }>,
      { items: [] },
    ),
  ]);

  // The DB reads below are guarded exactly like the cluster reads above, because
  // the single most important moment for this endpoint is a node loss — and if
  // that node held the Postgres primary, the database is mid-failover for a
  // couple of minutes precisely while the operator is trying to see what broke.
  //
  // Node readiness comes from Kubernetes, so "which node is down" survives a
  // database outage. Tenant impact does not. Degrading to "that node is offline,
  // tenant impact unknown" beats failing the whole response, and `readError`
  // keeps that honest instead of reporting a reassuring zero affected tenants.
  //
  // Tenant rows include `is_system` tenants deliberately — the SYSTEM tenant owns
  // the apex domain and its mail, so an operator needs to see it degrade too.
  const tenantRows = await guard(
    'tenants',
    () => db
      .select({
        id: tenants.id,
        name: tenants.name,
        ns: tenants.kubernetesNamespace,
        tier: tenants.storageTier,
        pin: tenants.nodeName,
        status: tenants.status,
      })
      .from(tenants),
    [],
  );

  // One grouped count instead of a query per tenant.
  const mailboxCounts = await guard(
    'mailbox counts',
    () => db
      .select({ tenantId: mailboxes.tenantId, n: sql<number>`count(*)::int` })
      .from(mailboxes)
      .groupBy(mailboxes.tenantId),
    [],
  );
  const hasMail = new Set(
    mailboxCounts.filter((r) => Number(r.n) > 0 && r.tenantId).map((r) => r.tenantId as string),
  );

  const [settings] = await guard(
    'mail placement',
    () => db
      .select({ activeNode: systemSettings.mailActiveNode })
      .from(systemSettings)
      .where(eq(systemSettings.id, 'system')),
    [],
  );

  const nodes: NodeFact[] = (nodeResp.items ?? []).map((n) => ({
    name: n.metadata?.name ?? '<unnamed>',
    ready: nodeIsReady(n),
    role: n.metadata?.labels?.[NODE_ROLE_LABEL] ?? null,
    // Absent label means 'all' — the same clamp k8s-sync applies, so a node
    // with no explicit mode is not mistaken for one that serves no traffic.
    ingressMode: n.metadata?.labels?.[INGRESS_MODE_LABEL] ?? 'all',
    ingressAddresses: publicAddresses(n),
    notReadySince: nodeIsReady(n) ? null : readyTransition(n),
  }));

  const tenantNamespaces = new Set(
    tenantRows.map((t) => t.ns).filter((ns): ns is string => !!ns),
  );
  const pods: PodFact[] = (podResp.items ?? [])
    .filter((p) => tenantNamespaces.has(p.metadata?.namespace ?? ''))
    .map((p) => ({
      namespace: p.metadata?.namespace ?? '',
      name: p.metadata?.name ?? '',
      nodeName: p.spec?.nodeName ?? null,
      ready: podIsReady(p),
      phase: p.status?.phase ?? 'Unknown',
    }));

  const replicas: ReplicaFact[] = (replicaResp.items ?? []).map((r) => ({
    volumeName: r.spec?.volumeName ?? '',
    nodeId: r.spec?.nodeID ?? null,
  })).filter((r) => r.volumeName !== '');

  const volumes: VolumeFact[] = (volumeResp.items ?? []).map((v) => ({
    volumeName: v.metadata?.name ?? '',
    namespace: v.status?.kubernetesStatus?.namespace ?? null,
    pvcName: v.status?.kubernetesStatus?.pvcName ?? null,
    robustness: v.status?.robustness ?? null,
  })).filter((v) => v.volumeName !== '');

  const tenantFacts: TenantFact[] = tenantRows
    .filter((t) => !!t.ns)
    .map((t) => ({
      id: t.id,
      name: t.name,
      namespace: t.ns as string,
      storageTier: (t.tier as 'local' | 'ha') ?? 'local',
      pinnedNode: t.pin ?? null,
      status: String(t.status ?? 'active'),
      hasMailboxes: hasMail.has(t.id),
    }));

  return {
    nodes,
    pods,
    replicas,
    volumes,
    tenants: tenantFacts,
    mailActiveNode: settings?.activeNode ?? null,
    // A node-list failure is fatal to the verdict; the rest degrade the
    // detail but not the headline. Reporting any error is the safe choice.
    readError: errors.length > 0 ? errors.join('; ') : null,
  };
}
