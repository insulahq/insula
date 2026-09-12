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
import { tenants, mailboxes, systemSettings, clusterNodes } from '../../db/schema.js';
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
  status?: { currentState?: string };
}
interface LhVolume {
  metadata?: { name?: string };
  status?: {
    robustness?: string;
    kubernetesStatus?: { namespace?: string; pvcName?: string };
  };
}

/**
 * Platform services whose loss an operator must be told about by name.
 *
 * Deliberately a short, curated list rather than "every Service in the
 * platform namespaces": the point is to say *backups are unavailable*, not to
 * emit a wall of internal service names during an incident. Add an entry when
 * a service's silent absence would mislead.
 */
export const WATCHED_PLATFORM_SERVICES: ReadonlyArray<{
  namespace: string; name: string; label: string;
}> = [
  { namespace: 'cnpg-system', name: 'barman-cloud', label: 'Backups (barman-cloud plugin)' },
];

export interface EndpointFact {
  readonly namespace: string;
  readonly serviceName: string;
  readonly readyEndpoints: number;
}

export interface CollectedFacts {
  readonly nodes: NodeFact[];
  readonly pods: PodFact[];
  readonly replicas: ReplicaFact[];
  readonly volumes: VolumeFact[];
  readonly tenants: TenantFact[];
  readonly mailActiveNode: string | null;
  readonly endpoints: EndpointFact[];
  readonly readError: string | null;
  /**
   * Oldest `last_seen_at` behind `nodes` when they came from the platform's
   * own inventory instead of a live read. Null means the list is live.
   */
  readonly nodesAsOf: string | null;
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

  // When the live node read fails, fall back to the inventory the node-sync
  // reconciler persists every 60 s.
  //
  // Losing the control plane otherwise loses the node NAMES too, because the
  // node list is itself an API-server read — the 2026-09-12 quorum-loss drill
  // left the platform able to say something was wrong but not which machine.
  // The database survives that: its primary sat on the surviving node and
  // served throughout, including operator logins.
  //
  // The fallback is deliberately only for the read FAILURE path. A live read
  // that legitimately returns zero nodes is a different thing and must not be
  // quietly replaced with stale rows.
  let nodesAsOf: string | null = null;
  let rawNodes: RawNode[] = nodeResp.items ?? [];
  if (errors.some((e) => e.startsWith('nodes:'))) {
    const cached = await guard(
      'cached nodes',
      () => db
        .select({
          name: clusterNodes.name,
          role: clusterNodes.role,
          ingressMode: clusterNodes.ingressMode,
          publicIp: clusterNodes.publicIp,
          publicIpv6: clusterNodes.publicIpv6,
          statusConditions: clusterNodes.statusConditions,
          lastSeenAt: clusterNodes.lastSeenAt,
        })
        .from(clusterNodes),
      [] as Array<{
        name: string; role: string | null; ingressMode: string | null;
        publicIp: string | null; publicIpv6: string | null;
        statusConditions: Array<{ type: string; status: string }> | null;
        lastSeenAt: Date | string;
      }>,
    );
    if (cached.length > 0) {
      rawNodes = cached.map((c) => ({
        metadata: {
          name: c.name,
          labels: {
            [NODE_ROLE_LABEL]: c.role ?? 'worker',
            [INGRESS_MODE_LABEL]: c.ingressMode ?? 'all',
          },
        },
        status: {
          conditions: (c.statusConditions ?? []) as RawNode['status'] extends undefined
            ? never : NonNullable<RawNode['status']>['conditions'],
          addresses: [
            ...(c.publicIp ? [{ type: 'ExternalIP', address: c.publicIp }] : []),
            ...(c.publicIpv6 ? [{ type: 'ExternalIP', address: c.publicIpv6 }] : []),
          ],
        },
      }));
      const oldest = cached
        .map((c) => (c.lastSeenAt instanceof Date ? c.lastSeenAt : new Date(c.lastSeenAt)))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      nodesAsOf = oldest ? oldest.toISOString() : null;
    }
  }

  const nodes: NodeFact[] = rawNodes.map((n) => ({
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
    // Only a RUNNING replica holds data. Longhorn schedules an empty rebuild
    // target on a survivor the moment a node dies; counting that as a copy is
    // how "your data is on the dead node" becomes "rebuilding, no action
    // required".
    running: r.status?.currentState === 'running',
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

  // Ready-endpoint counts for the watched platform services. Read per service
  // rather than listing every slice in the cluster: a handful of targeted reads
  // during an incident beats one large one.
  const endpoints: EndpointFact[] = [];
  for (const svc of WATCHED_PLATFORM_SERVICES) {
    const slices = await guard(
      `endpoints ${svc.namespace}/${svc.name}`,
      () => k8s.disco.listNamespacedEndpointSlice({
        namespace: svc.namespace,
        labelSelector: `kubernetes.io/service-name=${svc.name}`,
      } as unknown as Parameters<typeof k8s.disco.listNamespacedEndpointSlice>[0]) as Promise<{
        items?: Array<{ endpoints?: Array<{ conditions?: { ready?: boolean } }> }>;
      }>,
      { items: [] },
    );
    let ready = 0;
    for (const sl of slices.items ?? []) {
      for (const ep of sl.endpoints ?? []) if (ep.conditions?.ready) ready += 1;
    }
    endpoints.push({ namespace: svc.namespace, serviceName: svc.name, readyEndpoints: ready });
  }

  return {
    nodes,
    pods,
    replicas,
    volumes,
    tenants: tenantFacts,
    endpoints,
    mailActiveNode: settings?.activeNode ?? null,
    nodesAsOf,
    // A node-list failure is fatal to the verdict; the rest degrade the
    // detail but not the headline. Reporting any error is the safe choice.
    readError: errors.length > 0 ? errors.join('; ') : null,
  };
}
