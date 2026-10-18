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
 * Longhorn's instance managers (its engines and replicas) are not DaemonSet
 * pods at all: Longhorn creates them with the tolerations of that setting.
 * `taintBlocksSystem` says so before the taint goes on; host-migration
 * 2026.10.12/0002 is what makes it false.
 */
import { ApiError } from '../../shared/errors.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export const SERVER_ONLY_TAINT = 'insula.host/server-only';

/** The taint's value, as updateNode writes it. */
const SERVER_ONLY_VALUE = 'true';

interface Toleration { readonly key?: string; readonly operator?: string; readonly value?: string; readonly effect?: string }

/** Pure: does this toleration list cover the server-only NoSchedule taint (insula.host/server-only=true)? */
export function toleratesServerOnly(tolerations: readonly Toleration[] | undefined): boolean {
  return (tolerations ?? []).some((t) => {
    const effectOk = t.effect === undefined || t.effect === '' || t.effect === 'NoSchedule';
    if (!effectOk) return false;
    if (t.operator === 'Exists') return t.key === undefined || t.key === '' || t.key === SERVER_ONLY_TAINT;
    // Operator Equal (the default when absent) matches only the same value.
    return t.key === SERVER_ONLY_TAINT && (t.value ?? '') === SERVER_ONLY_VALUE;
  });
}

/** Pure: does Longhorn's `taint-toleration` setting value (`key=value:Effect;…`) cover the taint? */
export function longhornSettingToleratesServerOnly(value: string | undefined): boolean {
  return (value ?? '').split(';').map((e) => e.trim()).filter((e) => e !== '').some((e) => {
    const m = /^([^=:]*)(?:=([^:]*))?(?::(.*))?$/.exec(e);
    if (!m) return false;
    const [, key = '', val, effect] = m;
    const effectOk = effect === undefined || effect === '' || effect === 'NoSchedule';
    if (!effectOk) return false;
    if (key === '') return val === undefined; // ":NoSchedule" / "" with no key = tolerate everything (Exists)
    return key === SERVER_ONLY_TAINT && (val === undefined || val === SERVER_ONLY_VALUE);
  });
}

const LONGHORN_SETTING = 'longhorn-system/setting taint-toleration';

const statusOf = (err: unknown): number | undefined =>
  (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;

/**
 * Longhorn parts that would NOT come back on a server carrying the taint —
 * its DaemonSets, and its `taint-toleration` setting (instance managers) —
 * empty when Longhorn tolerates it or is not installed.
 */
export async function taintBlocksSystem(k8s: K8sClients): Promise<string[]> {
  let items: Array<{ metadata?: { name?: string }; spec?: { template?: { spec?: { tolerations?: Toleration[] } } } }>;
  try {
    const list = await k8s.apps.listNamespacedDaemonSet({ namespace: 'longhorn-system' }) as { items?: typeof items };
    items = list.items ?? [];
  } catch (err) {
    if (statusOf(err) === 404) return [];
    throw err;
  }
  if (items.length === 0) return []; // no Longhorn here
  const blocked = items
    .filter((d) => !toleratesServerOnly(d.spec?.template?.spec?.tolerations))
    .map((d) => `longhorn-system/${d.metadata?.name ?? '?'}`);

  let setting: string | undefined;
  try {
    const obj = await k8s.custom.getNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system',
      plural: 'settings', name: 'taint-toleration',
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as { value?: string };
    setting = obj.value;
  } catch (err) {
    if (statusOf(err) !== 404) throw err; // unreadable: fail closed (caller refuses)
  }
  return longhornSettingToleratesServerOnly(setting) ? blocked : [...blocked, LONGHORN_SETTING];
}

/** Refuse — before anything changes — to put the taint on while it would cost a server its storage. */
export async function assertTaintSafeForSystem(k8s: K8sClients, node: string): Promise<void> {
  let blocked: string[];
  try {
    blocked = await taintBlocksSystem(k8s);
  } catch (err) {
    // Fail closed, and say so — an unread check is not a passed one.
    throw new ApiError(
      'NODE_TAINT_PRECHECK_FAILED',
      `Cannot stop new tenants on '${node}': reading Longhorn's DaemonSets or its taint-toleration setting failed ` +
      `(${(err as Error).message.split('\n')[0]}), so it is not known whether storage would still start there. ` +
      `Nothing was changed.`,
      503,
      { node_name: node },
    );
  }
  if (blocked.length === 0) return;
  throw new ApiError(
    'NODE_TENANT_TAINT_UNSAFE',
    `Cannot stop new tenants on '${node}' yet: ${blocked.join(', ')} would not start there after a reboot, ` +
    `and the server would lose its storage. The 2026.10.12 upgrade adds the toleration; nothing was changed.`,
    409,
    { node_name: node, components: blocked },
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
 * cordoned, nothing deleted — when an eviction is refused or a pod is still
 * there when the wait runs out (pressing Delete again resumes). Returns how
 * many pods were evicted.
 *
 * `self` is the API pod serving this request: never evicted (that would cut
 * the request off mid-delete); it goes with the node, and its ReplicaSet
 * starts a replacement elsewhere.
 */
export async function moveSystemPodsOff(
  k8s: K8sClients,
  node: string,
  waitMs: number,
  self: { readonly namespace: string; readonly name: string } | null,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  await k8s.core.patchNode({
    name: node,
    body: { spec: { unschedulable: true } },
  } as unknown as Parameters<typeof k8s.core.patchNode>[0], STRATEGIC_MERGE_PATCH);

  const isSelf = (p: { namespace: string; name: string }) =>
    self !== null && p.namespace === self.namespace && p.name === self.name;
  const list = async () => podsToMoveOff(((await k8s.core.listPodForAllNamespaces({
    fieldSelector: `spec.nodeName=${node}`,
  })) as { items?: PodLite[] }).items ?? []).filter((p) => !isSelf(p));

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
      const code = statusOf(err);
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
  let left = await list();
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(3000);
    left = await list();
  }
  if (left.length > 0) {
    const names = left.map((p) => `${p.namespace}/${p.name}`);
    throw new ApiError(
      'NODE_DELETE_EVICTION_BLOCKED',
      `Node '${node}' is cordoned and its system pods were evicted, but ${names.length} still shut(s) down after ` +
      `${Math.round(waitMs / 1000)} s: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}. Nothing was ` +
      `deleted — press Delete again once they are gone.`,
      409,
      { node_name: node, pods: names.slice(0, 20) },
    );
  }
  return evicted;
}
