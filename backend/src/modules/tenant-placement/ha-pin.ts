/**
 * An HA tenant moved to a node gets what a deploy of it there renders.
 *
 * A move — a drain's re-pin, the recovery wizard, a failback, the Storage
 * card — wrote `nodeSelector: kubernetes.io/hostname=<target>` on every
 * workload, whatever the tier. On the HA tier that is the pin the tier exists
 * to avoid: the volume has a copy on another node, and the pin keeps the pods
 * off it when the node is lost. Auto-repin had to clear it first, and a node
 * back before it ran left the pinned pods on it while the others had taken
 * the volume elsewhere. Production: an HA tenant moved before this kept three
 * apps hard-pinned to the node it was moved to, the rest held only by the
 * soft preference.
 *
 * So a move renders the deploy's scheduling (pod-placement.ts
 * tenantPodScheduling): a soft preference for the target and, on the tenant's
 * workloads, the keep-together preference. Every hostname rule goes; every
 * other rule is kept.
 *
 * Plus, on the running tenant apps, `kubernetes.io/hostname NotIn [<node>]`
 * while the move leaves a node that is up. With soft rules alone their
 * restarted pods are pulled back: the
 * scheduler counts the tenant's pods still terminating there
 * (interpodaffinity counts terminating pods), and the keep-together
 * preference for that node ties with the preference for the target. Kept off
 * it, the first pod goes to the target and the others follow. A down node
 * needs none: its taint keeps new pods off, and no exclusion is left that
 * would keep them off it once it is back. The next deploy renders the
 * scheduling whole and drops it; so do the next move and the keep-together
 * patch of a failover (ha-colocation.ts).
 */
import { isDeepStrictEqual } from 'node:util';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { toMergePatch } from '../../shared/merge-patch.js';
import { HOSTNAME_LABEL, TENANT_WORKLOAD_LABEL, tenantPodScheduling } from './pod-placement.js';

type Json = Record<string, unknown>;

/** Stamped to replace running pods whose template is otherwise unchanged (tenant-migration/repin.ts). */
export const RESTARTED_AT_ANNOTATION = 'insula.host/restarted-at';

interface ExpressionLike {
  readonly key?: string;
  readonly operator?: string;
  readonly values?: readonly string[];
}

interface NodeSelectorTermLike {
  readonly matchExpressions?: readonly ExpressionLike[];
  readonly matchFields?: readonly unknown[];
  readonly [k: string]: unknown;
}

interface PreferredTermLike {
  readonly weight?: number;
  readonly preference?: NodeSelectorTermLike;
}

export interface PodSchedulingLike {
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly affinity?: unknown;
}

export interface HaPinOptions {
  /** The node the tenant is moved to. */
  readonly target: string;
  /** A node that is up and being left: the pods are kept off it. */
  readonly keepOff: string | null;
  /** A tenant workload (the deployers' label): it also gets the keep-together preference. */
  readonly tenantWorkload: boolean;
}

/** The client hands back typed objects whose absent fields are `undefined`; compare their JSON. */
const asJson = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

/** The term without its hostname expressions, or null when nothing is left of it. */
function withoutHostname(term: NodeSelectorTermLike): NodeSelectorTermLike | null {
  const kept = (term.matchExpressions ?? []).filter((e) => e.key !== HOSTNAME_LABEL);
  const hasFields = Array.isArray(term.matchFields) && term.matchFields.length > 0;
  // An empty term matches every node: dropped, not kept as "no constraint".
  if (kept.length === 0 && !hasFields) return null;
  const rest = Object.fromEntries(Object.entries(term).filter(([k]) => k !== 'matchExpressions'));
  return kept.length > 0 ? { ...rest, matchExpressions: kept } : rest;
}

const isTerm = <T>(t: T | null): t is T => t !== null;

/** The node affinity a move renders, from the current one. Pure. */
function movedNodeAffinity(current: Json | undefined, opts: HaPinOptions): Json {
  const nodeAffinity: Json = { ...current };
  const required = current?.requiredDuringSchedulingIgnoredDuringExecution as
    | { readonly nodeSelectorTerms?: readonly NodeSelectorTermLike[] } | undefined;

  let terms = (required?.nodeSelectorTerms ?? []).map(withoutHostname).filter(isTerm);
  if (opts.keepOff) {
    const notIn: ExpressionLike = { key: HOSTNAME_LABEL, operator: 'NotIn', values: [opts.keepOff] };
    // The terms are ORed: the exclusion goes into each of them.
    terms = terms.length > 0
      ? terms.map((t) => ({ ...t, matchExpressions: [...(t.matchExpressions ?? []), notIn] }))
      : [{ matchExpressions: [notIn] }];
  }
  if (terms.length > 0) {
    nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution = { ...required, nodeSelectorTerms: terms };
  } else {
    delete nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution;
  }

  const preferred = ((current?.preferredDuringSchedulingIgnoredDuringExecution as readonly PreferredTermLike[] | undefined) ?? [])
    .map((t) => {
      const preference = t.preference ? withoutHostname(t.preference) : null;
      return preference ? { ...t, preference } : null;
    })
    .filter(isTerm);
  const rendered = tenantPodScheduling({ nodeName: opts.target, storageTier: 'ha' })
    .affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution ?? [];
  nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution = [...preferred, ...rendered];
  return nodeAffinity;
}

/**
 * The JSON merge patch for one pod spec's `nodeSelector` and `affinity`, or
 * null when it already carries what the move renders. Pure.
 */
export function haPinSchedulingPatch(spec: PodSchedulingLike | undefined, opts: HaPinOptions): Json | null {
  const before = asJson({ nodeSelector: spec?.nodeSelector, affinity: spec?.affinity }) as {
    nodeSelector?: Record<string, string>; affinity?: Json;
  };

  const otherSelectors = Object.fromEntries(Object.entries(before.nodeSelector ?? {}).filter(([k]) => k !== HOSTNAME_LABEL));
  const affinity: Json = {
    ...before.affinity,
    nodeAffinity: movedNodeAffinity(before.affinity?.nodeAffinity as Json | undefined, opts),
  };
  if (opts.tenantWorkload) {
    affinity.podAffinity = tenantPodScheduling({ nodeName: opts.target, storageTier: 'ha' }).affinity?.podAffinity;
  }
  const after = {
    nodeSelector: Object.keys(otherSelectors).length > 0 ? otherSelectors : undefined,
    affinity,
  };
  if (isDeepStrictEqual(before, asJson(after))) return null;
  return toMergePatch(before, after) as Json;
}

interface WorkloadLike {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly replicas?: number;
    readonly template?: {
      readonly metadata?: { readonly labels?: Readonly<Record<string, string>> };
      readonly spec?: PodSchedulingLike;
    };
  };
}

/** The tenant's on-demand file manager: placed with the data when it starts (file-manager/k8s-lifecycle.ts). */
export const FILE_MANAGER_DEPLOYMENT = 'file-manager';

export interface HaPinResult {
  /** `Kind/name` of the workloads patched. */
  readonly patched: string[];
  /** Deployments with replicas > 0 among them. */
  readonly running: number;
  readonly failed: Array<{ readonly workload: string; readonly error: string }>;
}

/**
 * Give every Deployment (and, with `statefulSets`, StatefulSet) in an HA
 * tenant's namespace the scheduling of a move to `target`, except the file
 * manager, which the caller pins as before. `restartedAt` also stamps the
 * restart annotation, for a workload whose scheduling is unchanged but whose
 * pods must be placed again. Throws only when the workloads cannot be listed;
 * a workload that cannot be patched is reported in `failed`.
 */
export async function pinHaTenantSoftly(
  k8s: Pick<K8sClients, 'apps'>,
  namespace: string,
  target: string,
  opts: { readonly keepOff: string | null; readonly statefulSets: boolean; readonly restartedAt?: string },
): Promise<HaPinResult> {
  const patched: string[] = [];
  const failed: Array<{ workload: string; error: string }> = [];
  let runningCount = 0;

  const kinds: Array<'Deployment' | 'StatefulSet'> = opts.statefulSets ? ['Deployment', 'StatefulSet'] : ['Deployment'];
  for (const kind of kinds) {
    const list = (kind === 'Deployment'
      ? await k8s.apps.listNamespacedDeployment({ namespace })
      : await k8s.apps.listNamespacedStatefulSet({ namespace })) as { items?: WorkloadLike[] };
    for (const w of list.items ?? []) {
      const name = w.metadata?.name;
      if (!name || (kind === 'Deployment' && name === FILE_MANAGER_DEPLOYMENT)) continue;
      const tenantWorkload = w.spec?.template?.metadata?.labels?.[TENANT_WORKLOAD_LABEL] === 'true';
      const running = (w.spec?.replicas ?? 1) > 0;
      const scheduling = haPinSchedulingPatch(w.spec?.template?.spec, {
        target,
        // Only where a pod can be pulled back: a running app with the
        // keep-together preference. A platform pod has none, and a stopped app
        // has no pod to place. Anything more is an exclusion that outlives the
        // move, on a node that may hold the surviving copy.
        keepOff: kind === 'Deployment' && tenantWorkload && running ? opts.keepOff : null,
        tenantWorkload,
      });
      if (!scheduling && !opts.restartedAt) continue;
      const template: Json = scheduling ? { spec: scheduling } : {};
      if (opts.restartedAt) {
        template.metadata = { annotations: { [RESTARTED_AT_ANNOTATION]: opts.restartedAt } };
      }
      const body = { spec: { template } };
      try {
        if (kind === 'Deployment') {
          await k8s.apps.patchNamespacedDeployment({
            namespace, name, body,
          } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0], MERGE_PATCH);
          if (running) runningCount += 1;
        } else {
          await k8s.apps.patchNamespacedStatefulSet({
            namespace, name, body,
          } as unknown as Parameters<typeof k8s.apps.patchNamespacedStatefulSet>[0], MERGE_PATCH);
        }
        patched.push(`${kind}/${name}`);
      } catch (err) {
        failed.push({ workload: `${kind}/${name}`, error: (err as Error).message });
      }
    }
  }
  return { patched, running: runningCount, failed };
}
