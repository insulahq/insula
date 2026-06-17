import { KubeConfig } from '@kubernetes/client-node';
import { applyRaw } from './k8s-patch.js';

/**
 * Reliable Deployment scaling — the SDK serializer drops `replicas: 0`.
 *
 * `@kubernetes/client-node` v1.x runs every typed `patchNamespaced*` body
 * through `ObjectSerializer`, which omits `spec.replicas` when its value is
 * `0` (zero is treated as an unset/default integer). So
 * `patchNamespacedDeployment({ body: { spec: { replicas: 0 } } }, STRATEGIC_MERGE_PATCH)`
 * is serialized to `{ spec: {} }` and the apiserver applies a NO-OP — the
 * Deployment stays at its old replica count. This silently broke quiesce's
 * scale-to-0 (the root cause of destructive-shrink quiesce timeouts: the
 * file-manager pod was never asked to terminate, so `waitForQuiesced` hung)
 * and the file-manager idle-cleanup. A non-zero scale (e.g. unquiesce → N)
 * serializes fine, which is why only scale-to-0 was affected.
 *
 * `applyRaw` sends the body as raw JSON over the wire (Server-Side Apply),
 * so `0` survives. force:true claims `spec.replicas` for a stable
 * fieldManager — harmless co-ownership; other managers keep template/selector.
 */
let cachedKc: KubeConfig | null = null;
function clusterKubeConfig(): KubeConfig {
  if (!cachedKc) {
    const kc = new KubeConfig();
    kc.loadFromCluster();
    cachedKc = kc;
  }
  return cachedKc;
}

export async function scaleDeploymentReplicas(
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  await applyRaw(
    clusterKubeConfig(),
    { apiVersion: 'apps/v1', kind: 'Deployment', resource: 'deployments', apiPath: 'apis/apps/v1', namespace, name },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace }, spec: { replicas } },
    { fieldManager: 'platform-storage-quiesce', force: true },
  );
}
