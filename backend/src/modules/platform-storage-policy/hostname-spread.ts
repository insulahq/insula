/**
 * Keep the two replicas of an HA operator on two different servers.
 *
 * The leader-elect tier (cert-manager, the CNPG operator, sealed-secrets, …)
 * is scaled to 2 in HA so a server loss leaves a warm standby. Their pod
 * templates — installed by bootstrap, not Flux — carried no spread rule at
 * all, so whenever only one server could take a pod both replicas landed on
 * it and stayed there. Production: one server powered off while
 * another was cordoned; every second cert-manager replica moved onto the third
 * and nothing ever moved them back — losing that one server would have taken
 * both.
 *
 * The rule: one replica per node, hard (`DoNotSchedule`), counted per rollout
 * revision (`matchLabelKeys: pod-template-hash`) so a rolling update never
 * waits on its own old pods. A node that is down or cordoned still counts as
 * a place the pod belongs, so a replacement WAITS for it instead of doubling
 * up, and lands back on it when it returns. On one server the rule is moot:
 * a single node is a single domain.
 *
 * Flux-managed Deployments are left alone: their template is Flux's (it
 * would revert this) and their spread rule lives in the manifest.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

export const HOSTNAME_TOPOLOGY_KEY = 'kubernetes.io/hostname';
const FLUX_OWNER_LABEL = 'kustomize.toolkit.fluxcd.io/name';

export interface SpreadConstraint {
  readonly maxSkew?: number;
  readonly topologyKey?: string;
  readonly whenUnsatisfiable?: string;
  readonly labelSelector?: { readonly matchLabels?: Readonly<Record<string, string>> };
  readonly matchLabelKeys?: readonly string[];
}

/** Pure: the constraint for a Deployment with these selector labels. */
export function hostnameSpreadFor(matchLabels: Readonly<Record<string, string>>): SpreadConstraint {
  return {
    maxSkew: 1,
    topologyKey: HOSTNAME_TOPOLOGY_KEY,
    whenUnsatisfiable: 'DoNotSchedule',
    labelSelector: { matchLabels: { ...matchLabels } },
    matchLabelKeys: ['pod-template-hash'],
  };
}

/** Pure: does the template already keep one replica per node, hard? */
export function hasHardHostnameSpread(constraints: readonly SpreadConstraint[] | undefined): boolean {
  return (constraints ?? []).some(
    (c) => c.topologyKey === HOSTNAME_TOPOLOGY_KEY && c.whenUnsatisfiable === 'DoNotSchedule' && (c.maxSkew ?? 1) <= 1,
  );
}

export interface SpreadDeploymentView {
  readonly metadata?: { readonly labels?: Readonly<Record<string, string>> };
  readonly spec?: {
    readonly selector?: { readonly matchLabels?: Readonly<Record<string, string>> };
    readonly template?: { readonly spec?: { readonly topologySpreadConstraints?: readonly SpreadConstraint[] } };
  };
}

/**
 * Pure: the constraint list to write, or null when there is nothing to do —
 * already spread, Flux's to manage, or no selector labels to count by.
 */
export function spreadPatchFor(live: SpreadDeploymentView): SpreadConstraint[] | null {
  if (live.metadata?.labels?.[FLUX_OWNER_LABEL]) return null;
  const constraints = live.spec?.template?.spec?.topologySpreadConstraints ?? [];
  if (hasHardHostnameSpread(constraints)) return null;
  const matchLabels = live.spec?.selector?.matchLabels;
  if (!matchLabels || Object.keys(matchLabels).length === 0) return null;
  return [...constraints.filter((c) => c.topologyKey !== HOSTNAME_TOPOLOGY_KEY), hostnameSpreadFor(matchLabels)];
}

/**
 * Add the rule to one Deployment if it lacks it. Returns true when it
 * patched. A missing Deployment is not an error (not every overlay has every
 * operator); anything else is thrown to the caller, which records it.
 */
export async function ensureHostnameSpread(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<boolean> {
  let live: SpreadDeploymentView;
  try {
    live = await k8s.apps.readNamespacedDeployment({ namespace, name }) as SpreadDeploymentView;
  } catch (err) {
    const code = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) return false;
    throw err;
  }
  const constraints = spreadPatchFor(live);
  if (!constraints) return false;
  await k8s.apps.patchNamespacedDeployment({
    namespace, name,
    body: { spec: { template: { spec: { topologySpreadConstraints: constraints } } } },
  } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0], MERGE_PATCH);
  return true;
}
