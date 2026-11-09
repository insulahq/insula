/**
 * An HA tenant re-pinned to Auto keeps its pods together.
 *
 * A deploy gives an HA tenant's workloads the keep-together preference
 * (pod-placement.ts HA_SHARED_VOLUME_AFFINITY). A Deployment last deployed
 * before the platform rendered it has none, and nothing else adds it: an
 * upgrade leaves every existing HA tenant without it. A re-pin to Auto —
 * auto-repin after a node outage, a drain, the recovery wizard — is when the
 * pods are placed again: force-deleted off the dead node, or drained. Without
 * the preference each is placed on its own, and one placed away from the
 * ReadWriteOnce volume never starts.
 *
 * So the re-pin renders what a deploy of the now-Auto tenant would: the
 * preference, no soft preference for the node being left, and no exclusion of
 * a node an earlier move left (ha-pin.ts). Every other affinity rule is kept.
 *
 * The template change restarts the workload, so it is made when the pod is
 * placed again anyway, and once:
 *  - a dead node (nodes/service.ts repinTenantPlacement, before the stranded
 *    pods are force-deleted): the Recreate rollout waits for them, so the
 *    pods come back once, from the patched template;
 *  - a drain (drainNode), after the node is blocked to tenants: patched
 *    before, a pod would restart on the node being emptied and be evicted
 *    again.
 * A re-pin that moves nothing (the recovery wizard on a live node) leaves the
 * template to the next deploy.
 */
import { isDeepStrictEqual } from 'node:util';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { HA_SHARED_VOLUME_AFFINITY, HOSTNAME_LABEL, TENANT_WORKLOAD_LABEL } from './pod-placement.js';

interface NodeTermLike {
  readonly preference?: {
    readonly matchExpressions?: ReadonlyArray<{ readonly key?: string; readonly operator?: string; readonly values?: readonly string[] }>;
  };
}

interface RequiredTermLike {
  readonly matchExpressions?: ReadonlyArray<{ readonly key?: string; readonly operator?: string; readonly values?: readonly string[] }>;
  readonly matchFields?: readonly unknown[];
}

export interface AffinityLike {
  readonly nodeAffinity?: {
    readonly requiredDuringSchedulingIgnoredDuringExecution?: { readonly nodeSelectorTerms?: readonly RequiredTermLike[] } | null;
    readonly preferredDuringSchedulingIgnoredDuringExecution?: readonly NodeTermLike[];
  };
  readonly podAffinity?: unknown;
}

interface DeploymentLike {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly replicas?: number;
    readonly template?: {
      readonly metadata?: { readonly labels?: Readonly<Record<string, string>> };
      readonly spec?: { readonly affinity?: AffinityLike };
    };
  };
}

/** A preferred term for exactly `kubernetes.io/hostname In [node]`. */
function prefersOnly(term: NodeTermLike, node: string): boolean {
  const exprs = term.preference?.matchExpressions ?? [];
  return exprs.length === 1
    && exprs[0]!.key === HOSTNAME_LABEL
    && exprs[0]!.operator === 'In'
    && exprs[0]!.values?.length === 1
    && exprs[0]!.values[0] === node;
}

/**
 * The JSON merge patch for one workload's `affinity`, or null when it already
 * carries the preference and prefers nothing of the node being left. Pure.
 *
 * The client hands back typed objects whose absent fields are `undefined`
 * properties, so the comparison runs on the JSON form.
 */
export function haColocationAffinityPatch(
  current: AffinityLike | undefined,
  releaseFrom: string,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const podAffinity = current?.podAffinity === undefined ? undefined : JSON.parse(JSON.stringify(current.podAffinity));
  if (!isDeepStrictEqual(podAffinity, HA_SHARED_VOLUME_AFFINITY)) {
    patch.podAffinity = HA_SHARED_VOLUME_AFFINITY;
  }

  const nodeAffinity = current?.nodeAffinity;
  const naPatch: Record<string, unknown> = {};
  const preferred = nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution;
  if (releaseFrom && Array.isArray(preferred)) {
    const kept = preferred.filter((t) => !prefersOnly(t, releaseFrom));
    if (kept.length !== preferred.length) {
      naPatch.preferredDuringSchedulingIgnoredDuringExecution = kept.length > 0 ? kept : null;
    }
  }
  // A move's exclusion of the node it left (ha-pin.ts): the pods are placed
  // again now, and that node may hold the surviving copy.
  const required = nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  const terms = required?.nodeSelectorTerms;
  if (Array.isArray(terms)) {
    const kept = terms.map(withoutExclusion).filter((t): t is RequiredTermLike => t !== null);
    if (kept.length !== terms.length || kept.some((t, i) => t !== terms[i])) {
      naPatch.requiredDuringSchedulingIgnoredDuringExecution = kept.length > 0 ? { nodeSelectorTerms: kept } : null;
    }
  }
  if (Object.keys(naPatch).length > 0) {
    const left = (key: 'preferredDuringSchedulingIgnoredDuringExecution' | 'requiredDuringSchedulingIgnoredDuringExecution') =>
      key in naPatch ? naPatch[key] !== null : nodeAffinity?.[key] != null;
    const anyLeft = left('preferredDuringSchedulingIgnoredDuringExecution')
      || left('requiredDuringSchedulingIgnoredDuringExecution');
    patch.nodeAffinity = anyLeft ? naPatch : null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Whether a required term keeps the pod off a node by hostname (a move's exclusion). Pure. */
function keepsOffANode(affinity: AffinityLike | undefined): boolean {
  return (affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? [])
    .some((t) => (t.matchExpressions ?? []).some((e) => e.key === HOSTNAME_LABEL && e.operator === 'NotIn'));
}

/**
 * The term without `kubernetes.io/hostname NotIn [...]`; the same object when
 * it has none; null when nothing is left of it (an empty term matches every
 * node). Pure.
 */
function withoutExclusion(term: RequiredTermLike): RequiredTermLike | null {
  const exprs = term.matchExpressions ?? [];
  const kept = exprs.filter((e) => !(e.key === HOSTNAME_LABEL && e.operator === 'NotIn'));
  if (kept.length === exprs.length) return term;
  const hasFields = Array.isArray(term.matchFields) && term.matchFields.length > 0;
  if (kept.length === 0 && !hasFields) return null;
  const rest = Object.fromEntries(Object.entries(term).filter(([k]) => k !== 'matchExpressions'));
  return kept.length > 0 ? { ...rest, matchExpressions: kept } : rest;
}

interface PodLike {
  readonly metadata?: {
    readonly labels?: Readonly<Record<string, string>>;
    readonly ownerReferences?: ReadonlyArray<{ readonly kind?: string; readonly name?: string }>;
  };
}

/** The Deployment a pod belongs to: its ReplicaSet's name less the template hash. Pure. */
export function deploymentOfPod(pod: PodLike): string | null {
  const owner = pod.metadata?.ownerReferences?.find((o) => o.kind === 'ReplicaSet');
  const hash = pod.metadata?.labels?.['pod-template-hash'];
  if (!owner?.name || !hash || !owner.name.endsWith(`-${hash}`)) return null;
  return owner.name.slice(0, -(hash.length + 1));
}

/**
 * Give the tenant workload Deployments that have a pod on `releaseFrom` the HA
 * preference, and drop their preference for that node. Only those, and the
 * stopped ones an earlier move keeps off a node: their pods are the ones
 * placed again, and a template change restarts the others for nothing.
 * `skip` = Deployments the caller already patched. Returns the names patched.
 * Never throws: the re-pin itself is still right without it.
 */
export async function ensureHaColocation(
  k8s: Pick<K8sClients, 'apps' | 'core'>,
  namespace: string,
  releaseFrom: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const patched: string[] = [];
  try {
    const pods = await k8s.core.listNamespacedPod({
      namespace, fieldSelector: `spec.nodeName=${releaseFrom}`,
    } as unknown as Parameters<typeof k8s.core.listNamespacedPod>[0]) as { items?: PodLike[] };
    const onNode = new Set((pods.items ?? []).map(deploymentOfPod).filter((n): n is string => n !== null));

    const list = await k8s.apps.listNamespacedDeployment({ namespace }) as { items?: DeploymentLike[] };
    for (const d of list.items ?? []) {
      const name = d.metadata?.name;
      // Also a stopped app still kept off a node by an earlier move: its next
      // start would be held off a node that may now hold the only copy, and at
      // 0 replicas the template change restarts nothing.
      const stoppedAndKeptOff = d.spec?.replicas === 0 && keepsOffANode(d.spec.template?.spec?.affinity);
      if (!name || !(onNode.has(name) || stoppedAndKeptOff) || skip.has(name)) continue;
      // The deployers' label (pod-placement.ts): not on the file manager or
      // the platform pods, which render their own scheduling.
      if (d.spec?.template?.metadata?.labels?.[TENANT_WORKLOAD_LABEL] !== 'true') continue;
      const affinity = haColocationAffinityPatch(d.spec.template.spec?.affinity, releaseFrom);
      if (!affinity) continue;
      try {
        await k8s.apps.patchNamespacedDeployment({
          namespace, name, body: { spec: { template: { spec: { affinity } } } },
        } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0], MERGE_PATCH);
        patched.push(name);
      } catch (err) {
        console.warn(`[ha-colocation] ${namespace}/${name}: could not add the keep-together preference:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[ha-colocation] ${namespace}: could not list its pods or Deployments:`, (err as Error).message);
  }
  return patched;
}
