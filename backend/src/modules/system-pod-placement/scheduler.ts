import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH, STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

/**
 * Periodic reconciler that asserts two cluster-wide invariants:
 *
 *  1. Helm-installed singleton control-plane Deployments (Longhorn CSI
 *     controllers, Calico typha + kube-controllers, Longhorn UI) carry
 *     `nodeSelector: insula.host/node-role=server` plus a
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
const NODE_ROLE_LABEL = 'insula.host/node-role';
const SERVER_ONLY_TAINT_KEY = 'insula.host/server-only';
const WORKER_RESERVE_PCT = 10;

interface SingletonTarget {
  readonly namespace: string;
  readonly name: string;
  /** When set, the reconciler also patches replica count to this value. */
  readonly replicas?: 'tracksHaServerCount' | number;
}

/**
 * Helm-installed Deployments we patch directly. Longhorn's CSI controllers
 * + UI have no operator on top so direct Deployment patches stick.
 */
const SINGLETONS: readonly SingletonTarget[] = Object.freeze([
  { namespace: 'longhorn-system', name: 'csi-attacher', replicas: 1 },
  { namespace: 'longhorn-system', name: 'csi-provisioner', replicas: 1 },
  { namespace: 'longhorn-system', name: 'csi-resizer', replicas: 1 },
  { namespace: 'longhorn-system', name: 'csi-snapshotter', replicas: 1 },
  { namespace: 'longhorn-system', name: 'longhorn-ui', replicas: 1 },
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

/**
 * Calico is operator-managed (`Installation.operator.tigera.io`). Direct
 * Deployment patches on calico-typha / calico-kube-controllers /
 * calico-apiserver are reverted by the Tigera operator on its next
 * reconcile, so we patch the Installation CR instead — Tigera then
 * propagates nodeSelector + tolerations to every component Deployment.
 */
async function reconcileCalicoInstallation(k8s: K8sClients): Promise<{ readonly patched: boolean; readonly error?: string }> {
  interface RawInstallation {
    readonly spec?: {
      readonly controlPlaneNodeSelector?: Record<string, string>;
      readonly controlPlaneTolerations?: ReadonlyArray<{ readonly key?: string; readonly operator?: string; readonly value?: string; readonly effect?: string }>;
      readonly typhaDeployment?: {
        readonly spec?: {
          readonly template?: {
            readonly spec?: {
              readonly nodeSelector?: Record<string, string>;
              readonly tolerations?: ReadonlyArray<{ readonly key?: string; readonly operator?: string; readonly value?: string; readonly effect?: string }>;
            };
          };
        };
      };
    };
  }
  let inst: RawInstallation | null = null;
  try {
    inst = await k8s.custom.getNamespacedCustomObject({
      group: 'operator.tigera.io', version: 'v1',
      plural: 'installations', name: 'default',
      namespace: '',
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as RawInstallation;
  } catch (err) {
    const status = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (status === 404) return { patched: false }; // Calico via operator not installed
    return { patched: false, error: `read installation: ${(err as Error).message}` };
  }

  const cpNs = inst.spec?.controlPlaneNodeSelector?.[NODE_ROLE_LABEL];
  const cpTol = inst.spec?.controlPlaneTolerations?.find((t) => t.key === SERVER_ONLY_TAINT_KEY) !== undefined;
  const typhaNs = inst.spec?.typhaDeployment?.spec?.template?.spec?.nodeSelector?.[NODE_ROLE_LABEL];
  const typhaTol = inst.spec?.typhaDeployment?.spec?.template?.spec?.tolerations
    ?.find((t) => t.key === SERVER_ONLY_TAINT_KEY) !== undefined;

  if (cpNs === 'server' && cpTol && typhaNs === 'server' && typhaTol) {
    return { patched: false };
  }

  const existingCpNs = inst.spec?.controlPlaneNodeSelector ?? {};
  const existingCpTol = inst.spec?.controlPlaneTolerations ?? [];
  const existingTyphaNs = inst.spec?.typhaDeployment?.spec?.template?.spec?.nodeSelector ?? {};
  const existingTyphaTol = inst.spec?.typhaDeployment?.spec?.template?.spec?.tolerations ?? [];

  const patch = {
    spec: {
      controlPlaneNodeSelector: { ...existingCpNs, [NODE_ROLE_LABEL]: 'server' },
      controlPlaneTolerations: [
        ...existingCpTol.filter((t) => t.key !== SERVER_ONLY_TAINT_KEY),
        { key: SERVER_ONLY_TAINT_KEY, operator: 'Exists', effect: 'NoSchedule' },
      ],
      typhaDeployment: {
        spec: {
          template: {
            spec: {
              nodeSelector: { ...existingTyphaNs, [NODE_ROLE_LABEL]: 'server' },
              tolerations: [
                ...existingTyphaTol.filter((t) => t.key !== SERVER_ONLY_TAINT_KEY),
                { key: SERVER_ONLY_TAINT_KEY, operator: 'Exists', effect: 'NoSchedule' },
              ],
            },
          },
        },
      },
    },
  };

  try {
    await (k8s.custom as unknown as {
      patchNamespacedCustomObject: (
        a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
        mw: typeof MERGE_PATCH,
      ) => Promise<unknown>;
    }).patchNamespacedCustomObject(
      {
        group: 'operator.tigera.io', version: 'v1',
        plural: 'installations', name: 'default',
        namespace: '',
        body: patch,
      },
      MERGE_PATCH,
    );
    console.log('[system-pod-placement] patched Calico Installation: controlPlane + typha pinned to server');
    return { patched: true };
  } catch (err) {
    return { patched: false, error: `patch installation: ${(err as Error).message}` };
  }
}

/**
 * Phase B: only the CNPG primary's PVC carries the
 * `recurring-job-group.longhorn.io/default: enabled` label. Replicas
 * lose the label and stop accumulating identical hourly snapshots.
 * On failover Longhorn's RecurringJob controller picks up the new
 * primary on the next tick (jobs are evaluated against PVC labels at
 * fire time). The demoted replica's existing snapshots stay on disk
 * but no NEW snapshots are taken there.
 */
const PRIMARY_ONLY_LABEL = 'recurring-job-group.longhorn.io/default';

async function reconcileCnpgPrimaryOnlySnapshots(k8s: K8sClients): Promise<{ readonly patched: number; readonly errors: readonly string[] }> {
  const errors: string[] = [];
  let patched = 0;

  interface RawCluster {
    readonly metadata?: { readonly name?: string; readonly namespace?: string };
    readonly status?: { readonly currentPrimary?: string };
  }
  let clusters: ReadonlyArray<RawCluster> = [];
  try {
    const resp = await k8s.custom.listClusterCustomObject({
      group: 'postgresql.cnpg.io', version: 'v1', plural: 'clusters',
    } as unknown as Parameters<typeof k8s.custom.listClusterCustomObject>[0]) as { items?: readonly RawCluster[] };
    clusters = resp.items ?? [];
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code !== 404) errors.push(`list cnpg clusters: ${(err as Error).message}`);
    return { patched, errors };
  }

  for (const cl of clusters) {
    const ns = cl.metadata?.namespace; const clusterName = cl.metadata?.name;
    const primary = cl.status?.currentPrimary;
    if (!ns || !clusterName || !primary) continue;

    let pvcs: ReadonlyArray<{ metadata?: { name?: string; labels?: Record<string, string> } }> = [];
    try {
      const resp = await k8s.core.listNamespacedPersistentVolumeClaim({
        namespace: ns,
        labelSelector: `cnpg.io/cluster=${clusterName}`,
      } as unknown as Parameters<typeof k8s.core.listNamespacedPersistentVolumeClaim>[0]) as { items?: typeof pvcs };
      pvcs = resp.items ?? [];
    } catch (err) {
      errors.push(`list pvcs for ${ns}/${clusterName}: ${(err as Error).message}`);
      continue;
    }

    for (const pvc of pvcs) {
      const pvcName = pvc.metadata?.name;
      if (!pvcName) continue;
      const isPrimary = pvcName === primary;
      const has = pvc.metadata?.labels?.[PRIMARY_ONLY_LABEL] === 'enabled';
      const want = isPrimary;
      if (has === want) continue;

      // Strategic-merge: `null` removes the label, the value adds it.
      const labelPatch = {
        metadata: { labels: { [PRIMARY_ONLY_LABEL]: want ? 'enabled' : null } },
      };
      try {
        await (k8s.core as unknown as {
          patchNamespacedPersistentVolumeClaim: (
            a: { namespace: string; name: string; body: unknown },
            mw: typeof STRATEGIC_MERGE_PATCH,
          ) => Promise<unknown>;
        }).patchNamespacedPersistentVolumeClaim(
          { namespace: ns, name: pvcName, body: labelPatch },
          STRATEGIC_MERGE_PATCH,
        );
        patched++;
        console.log(`[system-pod-placement] cnpg ${ns}/${clusterName}: pvc ${pvcName} recurring-jobs label → ${want ? 'enabled' : 'removed'} (primary=${primary})`);
      } catch (err) {
        errors.push(`patch pvc ${ns}/${pvcName}: ${(err as Error).message}`);
      }
    }
  }
  return { patched, errors };
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
      const c = await reconcileCalicoInstallation(k8s);
      const d = await reconcileCnpgPrimaryOnlySnapshots(k8s);
      const cErrors = c.error ? [c.error] : [];
      const allErrors = [...a.errors, ...b.errors, ...cErrors, ...d.errors];
      const total = a.patched + b.patched + (c.patched ? 1 : 0) + d.patched;
      if (total > 0 || allErrors.length > 0) {
        console.log(`[system-pod-placement] tick: longhorn-deps=${a.patched} worker-disks=${b.patched} calico-installation=${c.patched ? 1 : 0} cnpg-primary-labels=${d.patched} errors=${allErrors.length}`);
      }
      for (const e of allErrors) console.warn('[system-pod-placement]', e);
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
