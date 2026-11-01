import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { holdTenantVolumes, releaseVolumeHold } from '../tenant-placement/volume-pin.js';

const HOSTNAME_LABEL = 'kubernetes.io/hostname';
const RESTARTED_AT_ANNOTATION = 'insula.host/restarted-at';

/**
 * Pin the whole tenant to `nodeName`: its volumes first, then its Deployments.
 *
 * The volumes go first, as in a drain's re-pin: a volume still held to the node
 * the tenant left would keep its data there however the pods are pinned
 * (tenant-placement/volume-pin.ts). A failure there throws before any
 * Deployment changes. When a Deployment cannot be re-pinned, the volumes are
 * put back as they were before this throws: a volume held to a node the
 * tenant does not end up on is the stuck copy all over again.
 */
export async function repinTenant(
  k8s: K8sClients,
  namespace: string,
  nodeName: string,
  storageTier: string | null,
  opts: { readonly restart: boolean },
): Promise<number> {
  const hold = await holdTenantVolumes(k8s, namespace, nodeName, storageTier);
  try {
    return await repinDeployments(k8s, namespace, nodeName, opts);
  } catch (err) {
    const left = await releaseVolumeHold(k8s, hold);
    if (left.length === 0) throw err;
    throw new Error(`${err instanceof Error ? err.message : String(err)}; and could not put back the volume `
      + `selectors: ${left.join('; ')}`);
  }
}

/**
 * Pin every Deployment in the namespace to `nodeName`.
 *
 * `restart: true` also stamps a fresh restart annotation, combined in the same
 * patch, so running pods are replaced and pick up the new nodeSelector — a pure
 * rollout-restart alone would land them on the SAME node because the pod
 * template's nodeSelector is unchanged. `restart: false` is for a namespace
 * already scaled to 0: the pods its scale-up creates read the new template.
 *
 * Returns how many of the Deployments were running (replicas > 0). A file
 * manager idle at 0 is re-pinned but is not a restarted workload.
 */
export async function repinDeployments(
  k8s: K8sClients,
  namespace: string,
  nodeName: string,
  opts: { readonly restart: boolean },
): Promise<number> {
  let running = 0;
  const now = new Date().toISOString();

  const res = await k8s.apps.listNamespacedDeployment({ namespace });
  for (const deploy of res.items ?? []) {
    const name = deploy.metadata?.name;
    if (!name) continue;
    await k8s.apps.patchNamespacedDeployment({
      name,
      namespace,
      body: {
        spec: {
          template: {
            ...(opts.restart ? { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: now } } } : {}),
            spec: {
              nodeSelector: { [HOSTNAME_LABEL]: nodeName },
            },
          },
        },
      },
    } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
      STRATEGIC_MERGE_PATCH);
    if ((deploy.spec?.replicas ?? 1) > 0) running += 1;
  }
  return running;
}
