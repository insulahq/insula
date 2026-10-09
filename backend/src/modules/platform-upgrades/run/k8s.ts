/**
 * ADR-064 — the cluster side of an upgrade run: the node Plans, their per-node
 * jobs, and node readiness. Thin wrappers; every decision lives in the pure
 * modules (node-plan.ts, node-state.ts, machine.ts).
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../../shared/k8s-patch.js';
import { httpStatusOf } from '../../../shared/k8s-errors.js';
import { SUC_NAMESPACE, planNameFor, type NodePlanKind } from './node-plan.js';
import type { NodeFacts, NodeJobFacts } from './node-state.js';

const SUC = { group: 'upgrade.cattle.io', version: 'v1', namespace: SUC_NAMESPACE, plural: 'plans' } as const;

type CustomApi = {
  createNamespacedCustomObject: (req: Record<string, unknown>) => Promise<unknown>;
  patchNamespacedCustomObject: (req: Record<string, unknown>, mw: typeof MERGE_PATCH) => Promise<unknown>;
  deleteNamespacedCustomObject: (req: Record<string, unknown>) => Promise<unknown>;
};
const custom = (k8s: K8sClients): CustomApi => k8s.custom as unknown as CustomApi;

/** Create the Plan, or merge-patch it when it exists (a re-applied step, or a new run). */
export async function applyNodePlan(k8s: K8sClients, plan: Record<string, unknown>): Promise<void> {
  const name = (plan.metadata as { name: string }).name;
  try {
    await custom(k8s).createNamespacedCustomObject({ ...SUC, body: plan });
  } catch (err) {
    if (httpStatusOf(err) !== 409) throw err;
    await custom(k8s).patchNamespacedCustomObject({ ...SUC, name, body: { metadata: plan.metadata, spec: plan.spec } }, MERGE_PATCH);
  }
}

/** Delete a Plan; absent is fine. Deleting stops the controller from retrying its jobs. */
export async function deleteNodePlan(k8s: K8sClients, kind: NodePlanKind): Promise<void> {
  await deletePlanNamed(k8s, planNameFor(kind));
}

/** A Plan's existence and the controller's hash of its current spec (status.latestHash). */
export async function readPlanHash(k8s: K8sClients, name: string): Promise<{ readonly exists: boolean; readonly latestHash: string | null }> {
  try {
    const plan = (await (k8s.custom as unknown as { getNamespacedCustomObject: (r: Record<string, unknown>) => Promise<unknown> })
      .getNamespacedCustomObject({ ...SUC, name })) as { status?: { latestHash?: string } };
    return { exists: true, latestHash: plan.status?.latestHash || null };
  } catch (err) {
    if (httpStatusOf(err) === 404) return { exists: false, latestHash: null };
    throw err;
  }
}

export async function deletePlanNamed(k8s: K8sClients, name: string): Promise<void> {
  try {
    await custom(k8s).deleteNamespacedCustomObject({ ...SUC, name });
  } catch (err) {
    if (httpStatusOf(err) !== 404) throw err;
  }
}

interface RawJob {
  metadata?: { labels?: Record<string, string>; creationTimestamp?: string | Date };
  status?: { active?: number; failed?: number; succeeded?: number };
}

/**
 * Per-node job facts for one Plan, counting only jobs created since `sinceMs`
 * (the controller keeps finished jobs for a while; a previous run's must not
 * count against this one). Summed per node — a retried job is a new pod, not a
 * new job, but a re-created job is a new object.
 */
export async function listPlanJobs(k8s: K8sClients, kind: NodePlanKind, sinceMs: number): Promise<Map<string, NodeJobFacts>> {
  return listJobsForPlans(k8s, [planNameFor(kind)], sinceMs);
}

/** Per-node job facts across the given Plans (the Kubernetes step has two). */
export async function listJobsForPlans(k8s: K8sClients, planNames: readonly string[], sinceMs: number): Promise<Map<string, NodeJobFacts>> {
  const out = new Map<string, NodeJobFacts>();
  const list = (await k8s.batch.listNamespacedJob({
    namespace: SUC_NAMESPACE,
    labelSelector: `upgrade.cattle.io/plan in (${planNames.join(',')})`,
  } as unknown as Parameters<typeof k8s.batch.listNamespacedJob>[0])) as { items?: RawJob[] };
  for (const j of list.items ?? []) {
    const node = j.metadata?.labels?.['upgrade.cattle.io/node'];
    if (!node) continue;
    const created = j.metadata?.creationTimestamp ? new Date(j.metadata.creationTimestamp).getTime() : NaN;
    if (Number.isFinite(created) && created < sinceMs - 60_000) continue;
    const prev = out.get(node) ?? { active: 0, failed: 0, succeeded: 0 };
    out.set(node, {
      active: prev.active + (j.status?.active ?? 0),
      failed: prev.failed + (j.status?.failed ?? 0),
      succeeded: prev.succeeded + (j.status?.succeeded ?? 0),
    });
  }
  return out;
}

interface RawNode {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean };
  status?: { conditions?: Array<{ type?: string; status?: string }>; nodeInfo?: { kubeletVersion?: string } };
}

const PLAN_LABEL_PREFIX = 'plan.upgrade.cattle.io/';

function planHashesOf(labels: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels ?? {})
      .filter(([k]) => k.startsWith(PLAN_LABEL_PREFIX))
      .map(([k, v]) => [k.slice(PLAN_LABEL_PREFIX.length), v]),
  );
}

export async function listNodeFacts(k8s: K8sClients): Promise<NodeFacts[]> {
  const list = (await k8s.core.listNode()) as { items?: RawNode[] };
  return (list.items ?? [])
    .map((n) => ({
      name: n.metadata?.name ?? '',
      ready: (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
      kubeletVersion: n.status?.nodeInfo?.kubeletVersion ?? null,
      unschedulable: n.spec?.unschedulable === true,
      planHashes: planHashesOf(n.metadata?.labels),
    }))
    .filter((n) => n.name !== '')
    .sort((a, b) => a.name.localeCompare(b.name));
}
