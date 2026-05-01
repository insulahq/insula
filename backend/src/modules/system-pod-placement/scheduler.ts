import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH, STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

/**
 * Periodic reconciler that asserts two cluster-wide invariants:
 *
 *  1. Helm-installed singleton control-plane Deployments (Longhorn CSI
 *     controllers, Calico typha + kube-controllers, Longhorn UI) carry
 *     `nodeSelector: platform.phoenix-host.net/node-role=server` plus a
 *     toleration for the matching `server-only` taint, so they don't
 *     consume worker capacity.
 *
 *  2. Calico-typha replicas track the active platform-storage tier:
 *     1 in Local, server-count in HA. Lets the cluster scale Typha out
 *     when more servers come online.
 *
 *  3. Each worker node's Longhorn disk carries
 *     `spec.disks.<id>.storageReserved = floor(max * WORKER_RESERVE_PCT/100)`,
 *     overriding the cluster-default reserve percentage. New workers
 *     automatically get the lower 10 % reserve at first sync — no manual
 *     post-bootstrap kubectl needed.
 *
 * Why a reconciler vs. a one-shot bootstrap step: Helm chart upgrades
 * can revert affinity/replica fields back to their chart defaults; the
 * reconciler drift-corrects every cycle.
 */

const TICK_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;
const NODE_ROLE_LABEL = 'platform.phoenix-host.net/node-role';
const SERVER_ONLY_TAINT_KEY = 'platform.phoenix-host.net/server-only';
const WORKER_RESERVE_PCT = 10;

interface SingletonTarget {
  readonly namespace: string;
  readonly name: string;
  /** When set, the reconciler also patches replica count to this value. */
  readonly replicas?: 'tracksHaServerCount' | number;
}

const SINGLETONS: readonly SingletonTarget[] = Object.freeze([
  { namespace: 'longhorn-system', name: 'csi-attacher', replicas: 1 },
  { namespace: 'longhorn-system', name: 'csi-provisioner', replicas: 1 },
  { namespace: 'longhorn-system', name: 'csi-resizer', replicas: 1 },
  { namespace: 'longhorn-system', name: 'csi-snapshotter', replicas: 1 },
  { namespace: 'longhorn-system', name: 'longhorn-ui', replicas: 1 },
  { namespace: 'calico-system', name: 'calico-kube-controllers', replicas: 1 },
  { namespace: 'calico-system', name: 'calico-typha', replicas: 'tracksHaServerCount' },
]);

interface RawDeployment {
  readonly spec?: {
    readonly replicas?: number;
    readonly template?: {
      readonly spec?: {
        readonly nodeSelector?: Record<string, string>;
        readonly tolerations?: ReadonlyArray<{ readonly key?: string; readonly operator?: string; readonly value?: string; readonly effect?: string }>;
      };
    };
  };
}

function hasServerNodeSelector(d: RawDeployment): boolean {
  return d.spec?.template?.spec?.nodeSelector?.[NODE_ROLE_LABEL] === 'server';
}

function hasServerOnlyToleration(d: RawDeployment): boolean {
  for (const t of d.spec?.template?.spec?.tolerations ?? []) {
    if (t.key === SERVER_ONLY_TAINT_KEY && (t.operator === 'Exists' || t.operator === 'Equal')) return true;
  }
  return false;
}

async function patchDeployment(
  k8s: K8sClients,
  namespace: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  await (k8s.apps as unknown as {
    patchNamespacedDeployment: (
      a: { namespace: string; name: string; body: unknown },
      mw: typeof STRATEGIC_MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedDeployment(
    { namespace, name, body },
    STRATEGIC_MERGE_PATCH,
  );
}

async function readyServerCount(k8s: K8sClients): Promise<number> {
  const list = await k8s.core.listNode({}) as { items?: ReadonlyArray<{ metadata?: { labels?: Record<string, string> }; status?: { conditions?: ReadonlyArray<{ type?: string; status?: string }> } }> };
  let n = 0;
  for (const node of list.items ?? []) {
    const role = node.metadata?.labels?.[NODE_ROLE_LABEL];
    if (role !== 'server') continue;
    const ready = node.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True';
    if (ready) n++;
  }
  return n;
}

async function reconcileSingletonAffinity(k8s: K8sClients): Promise<{ readonly patched: number; readonly errors: readonly string[] }> {
  const errors: string[] = [];
  let patched = 0;
  const haServers = await readyServerCount(k8s);

  for (const t of SINGLETONS) {
    let dep: RawDeployment | null = null;
    try {
      dep = await k8s.apps.readNamespacedDeployment({ namespace: t.namespace, name: t.name }) as RawDeployment;
    } catch (err) {
      const status = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) errors.push(`read ${t.namespace}/${t.name}: ${(err as Error).message}`);
      continue; // 404 = chart not installed in this cluster — skip silently
    }
    const needNs = !hasServerNodeSelector(dep);
    const needTol = !hasServerOnlyToleration(dep);
    const desiredReplicas = t.replicas === 'tracksHaServerCount'
      ? Math.max(1, haServers)
      : t.replicas;
    const needReplicas = desiredReplicas !== undefined && (dep.spec?.replicas ?? 1) !== desiredReplicas;
    if (!needNs && !needTol && !needReplicas) continue;

    const patchBody: Record<string, unknown> = {};
    if (needReplicas) patchBody.spec = { replicas: desiredReplicas };
    if (needNs || needTol) {
      const tplSpec: Record<string, unknown> = {};
      if (needNs) {
        // Preserve any existing nodeSelector keys the chart has set
        // (e.g. `kubernetes.io/os: linux`) — strategic-merge merges
        // map keys, but we still spread defensively in case the
        // server applies a replace-style merge.
        const existing = dep.spec?.template?.spec?.nodeSelector ?? {};
        tplSpec.nodeSelector = { ...existing, [NODE_ROLE_LABEL]: 'server' };
      }
      if (needTol) {
        // Strategic-merge with a list patch needs explicit re-write of the
        // whole tolerations list; merge the existing entries to preserve
        // upstream defaults (e.g. NoExecute taints kubelet adds).
        const existing = dep.spec?.template?.spec?.tolerations ?? [];
        tplSpec.tolerations = [
          ...existing.filter((t2) => t2.key !== SERVER_ONLY_TAINT_KEY),
          { key: SERVER_ONLY_TAINT_KEY, operator: 'Exists', effect: 'NoSchedule' },
        ];
      }
      patchBody.spec = { ...(patchBody.spec as object | undefined ?? {}), template: { spec: tplSpec } };
    }

    try {
      await patchDeployment(k8s, t.namespace, t.name, patchBody);
      patched++;
      console.log(`[system-pod-placement] patched ${t.namespace}/${t.name}: ns=${needNs} tol=${needTol} replicas=${needReplicas ? desiredReplicas : 'unchanged'}`);
    } catch (err) {
      errors.push(`patch ${t.namespace}/${t.name}: ${(err as Error).message}`);
    }
  }
  return { patched, errors };
}

interface RawLhNode {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly disks?: Record<string, { readonly storageReserved?: number; readonly path?: string }> };
  readonly status?: { readonly diskStatus?: Record<string, { readonly storageMaximum?: number }> };
}

async function reconcileWorkerStorageReserve(k8s: K8sClients): Promise<{ readonly patched: number; readonly errors: readonly string[] }> {
  const errors: string[] = [];
  let patched = 0;
  const k8sNodesResp = await k8s.core.listNode({}) as { items?: ReadonlyArray<{ metadata?: { name?: string; labels?: Record<string, string> } }> };
  const workerNames = new Set<string>();
  for (const n of k8sNodesResp.items ?? []) {
    const role = n.metadata?.labels?.[NODE_ROLE_LABEL] ?? 'worker';
    if (role !== 'server' && n.metadata?.name) workerNames.add(n.metadata.name);
  }
  if (workerNames.size === 0) return { patched, errors };

  let lhNodes: ReadonlyArray<RawLhNode> = [];
  try {
    const resp = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'nodes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: readonly RawLhNode[] };
    lhNodes = resp.items ?? [];
  } catch (err) {
    const status = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (status !== 404) errors.push(`list longhorn nodes: ${(err as Error).message}`);
    return { patched, errors };
  }

  for (const lh of lhNodes) {
    const name = lh.metadata?.name;
    if (!name || !workerNames.has(name)) continue;
    const disks = lh.spec?.disks ?? {};
    const status = lh.status?.diskStatus ?? {};
    const desiredDisks: Record<string, { storageReserved: number }> = {};
    let needPatch = false;
    for (const [diskId, disk] of Object.entries(disks)) {
      const max = status[diskId]?.storageMaximum ?? 0;
      if (max <= 0) continue;
      const desired = Math.floor((max * WORKER_RESERVE_PCT) / 100);
      const current = disk.storageReserved ?? 0;
      // 1% slack — avoids noisy patches on rounding differences.
      if (Math.abs(current - desired) > Math.max(1, Math.floor(max * 0.01))) {
        desiredDisks[diskId] = { storageReserved: desired };
        needPatch = true;
      }
    }
    if (!needPatch) continue;

    try {
      await (k8s.custom as unknown as {
        patchNamespacedCustomObject: (
          a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
          mw: typeof MERGE_PATCH,
        ) => Promise<unknown>;
      }).patchNamespacedCustomObject(
        {
          group: 'longhorn.io', version: 'v1beta2',
          namespace: 'longhorn-system', plural: 'nodes',
          name,
          body: { spec: { disks: desiredDisks } },
        },
        MERGE_PATCH,
      );
      patched++;
      console.log(`[system-pod-placement] patched worker ${name} storageReserved → ${WORKER_RESERVE_PCT}%`);
    } catch (err) {
      errors.push(`patch worker ${name}: ${(err as Error).message}`);
    }
  }
  return { patched, errors };
}

export function startSystemPodPlacement(_db: Database, k8s: K8sClients): { readonly stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  console.log('[system-pod-placement] starting (5min cadence)');

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const a = await reconcileSingletonAffinity(k8s);
      const b = await reconcileWorkerStorageReserve(k8s);
      const total = a.patched + b.patched;
      if (total > 0 || a.errors.length > 0 || b.errors.length > 0) {
        console.log(`[system-pod-placement] tick: singletons=${a.patched} worker-disks=${b.patched} errors=${[...a.errors, ...b.errors].length}`);
      }
      for (const e of [...a.errors, ...b.errors]) console.warn('[system-pod-placement]', e);
    } catch (err) {
      console.error('[system-pod-placement] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
