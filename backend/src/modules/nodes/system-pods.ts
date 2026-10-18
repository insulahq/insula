/**
 * The system side of a node: what keeps running on a server whose tenants
 * were drained, and what has to leave before the node is deleted.
 *
 * "Drain tenants" keeps new tenants off a server with the server-only
 * NoSchedule taint ("Can host tenant workloads" off). Every system workload
 * tolerates it — except where it does not yet: Longhorn's per-node
 * DaemonSets take their tolerations from Longhorn's own setting, which a live
 * cluster applies late (only once volumes detach). A DaemonSet pod is
 * REPLACED when its node reboots, so a tainted server whose Longhorn CSI
 * plugin cannot be re-created comes back without storage.
 * `taintBlocksSystem` says so before the taint goes on; host-migration
 * 2026.10.12/0002 is what makes it false.
 */
import { ApiError } from '../../shared/errors.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export const SERVER_ONLY_TAINT = 'insula.host/server-only';

interface Toleration { readonly key?: string; readonly operator?: string; readonly effect?: string }

/** Pure: does this toleration list cover the server-only NoSchedule taint? */
export function toleratesServerOnly(tolerations: readonly Toleration[] | undefined): boolean {
  return (tolerations ?? []).some((t) =>
    (t.key === SERVER_ONLY_TAINT || ((t.key === undefined || t.key === '') && t.operator === 'Exists'))
    && (t.effect === undefined || t.effect === '' || t.effect === 'NoSchedule'));
}

/**
 * Longhorn DaemonSets that would NOT come back on a server carrying the
 * taint — empty when Longhorn tolerates it or is not installed.
 */
export async function taintBlocksSystem(k8s: K8sClients): Promise<string[]> {
  let items: Array<{ metadata?: { name?: string }; spec?: { template?: { spec?: { tolerations?: Toleration[] } } } }>;
  try {
    const list = await k8s.apps.listNamespacedDaemonSet({ namespace: 'longhorn-system' }) as { items?: typeof items };
    items = list.items ?? [];
  } catch (err) {
    const code = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) return [];
    throw err;
  }
  return items
    .filter((d) => !toleratesServerOnly(d.spec?.template?.spec?.tolerations))
    .map((d) => `longhorn-system/${d.metadata?.name ?? '?'}`);
}

/** Refuse — before anything changes — to put the taint on while it would cost a server its storage. */
export async function assertTaintSafeForSystem(k8s: K8sClients, node: string): Promise<void> {
  const blocked = await taintBlocksSystem(k8s);
  if (blocked.length === 0) return;
  throw new ApiError(
    'NODE_TENANT_TAINT_UNSAFE',
    `Cannot stop new tenants on '${node}' yet: ${blocked.join(', ')} would not start there after a reboot, ` +
    `and the server would lose its storage. The 2026.10.12 upgrade adds the toleration; nothing was changed.`,
    409,
    { node_name: node, daemonsets: blocked },
  );
}

interface PodLite {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly annotations?: Record<string, string>;
    readonly ownerReferences?: ReadonlyArray<{ readonly kind?: string }>;
  };
  readonly status?: { readonly phase?: string };
}

/** Pure: the pods that have to leave before the node goes — not DaemonSet or static pods, not finished ones. */
export function podsToMoveOff(pods: readonly PodLite[]): Array<{ namespace: string; name: string }> {
  return pods
    .filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed')
    .filter((p) => !p.metadata?.annotations?.['kubernetes.io/config.mirror'])
    .filter((p) => !(p.metadata?.ownerReferences ?? []).some((o) => o.kind === 'DaemonSet' || o.kind === 'Node'))
    .map((p) => ({ namespace: p.metadata?.namespace ?? '', name: p.metadata?.name ?? '' }))
    .filter((p) => p.namespace !== '' && p.name !== '');
}

/**
 * Cordon the node, evict what has to leave (disruption budgets respected),
 * then wait up to `waitMs` for it to be gone. Throws 409 — node left
 * cordoned, nothing deleted — when an eviction is refused. Returns how many
 * pods were evicted.
 */
export async function moveSystemPodsOff(
  k8s: K8sClients,
  node: string,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  await k8s.core.patchNode({
    name: node,
    body: { spec: { unschedulable: true } },
  } as unknown as Parameters<typeof k8s.core.patchNode>[0], STRATEGIC_MERGE_PATCH);

  const list = async () => podsToMoveOff(((await k8s.core.listPodForAllNamespaces({
    fieldSelector: `spec.nodeName=${node}`,
  })) as { items?: PodLite[] }).items ?? []);

  const evict = (k8s.core as unknown as {
    createNamespacedPodEviction: (req: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedPodEviction.bind(k8s.core);

  const refused: string[] = [];
  let evicted = 0;
  for (const p of await list()) {
    try {
      await evict({
        name: p.name,
        namespace: p.namespace,
        body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: p.name, namespace: p.namespace } },
      });
      evicted += 1;
    } catch (err) {
      const code = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (code === 404) continue; // already gone
      refused.push(`${p.namespace}/${p.name}${code === 429 ? ' (its disruption budget allows no eviction now)' : ''}`);
    }
  }
  if (refused.length > 0) {
    throw new ApiError(
      'NODE_DELETE_EVICTION_BLOCKED',
      `Node '${node}' is cordoned, but ${refused.length} system pod(s) could not be moved off: ${refused.slice(0, 5).join(', ')}` +
      `${refused.length > 5 ? ', …' : ''}. Nothing was deleted — resolve it (a database primary, for instance, needs a ` +
      `switchover first) and press Delete again.`,
      409,
      { node_name: node, pods: refused.slice(0, 20) },
    );
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && (await list()).length > 0) await sleep(3000);
  return evicted;
}
