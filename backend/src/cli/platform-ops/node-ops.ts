/**
 * Real node operations for platform-ops (ADR-045 W12) — operator maintenance
 * cordon/uncordon, talking to the k8s API directly (works when platform-api is
 * down). Draining (evict + tenant re-pin) is the DB-heavy backend `drainNode`
 * path and is a deferred follow-up; SUC agent Plans already drain during upgrade.
 */
import type { NodeOps } from './deps.js';

function kubeconfig(env: NodeJS.ProcessEnv): string {
  return env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
}

export function realNodeOps(env: NodeJS.ProcessEnv): NodeOps {
  async function clients() {
    const [{ createK8sClients }, { existsSync }] = await Promise.all([
      import('../../modules/k8s-provisioner/k8s-client.js'),
      import('node:fs'),
    ]);
    const kc = kubeconfig(env);
    return existsSync(kc) ? createK8sClients(kc) : createK8sClients();
  }

  return {
    async cordon(name, on): Promise<void> {
      const [k8s, { STRATEGIC_MERGE_PATCH }] = await Promise.all([clients(), import('../../shared/k8s-patch.js')]);
      await k8s.core.patchNode(
        { name, body: { spec: { unschedulable: on } } } as unknown as Parameters<typeof k8s.core.patchNode>[0],
        STRATEGIC_MERGE_PATCH,
      );
    },
  };
}
