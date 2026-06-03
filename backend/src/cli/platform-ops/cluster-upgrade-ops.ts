/**
 * Real cluster-upgrade operations for platform-ops (ADR-045 W12).
 *
 * `readNodeVersions` reads every node's kubelet/k3s version (to compute the
 * cluster's current minimum + role split); `applyPlans` creates the SUC Plan CRs
 * in the system-upgrade namespace (create-or-merge-patch, idempotent). Heavy k8s
 * client loads via dynamic import() so non-upgrade subcommands stay lean.
 */
import type { ClusterUpgradeOps, NodeVersion } from './deps.js';

const SUC_GROUP = 'upgrade.cattle.io';
const SUC_VERSION = 'v1';
const SUC_NAMESPACE = 'system-upgrade';
const SUC_PLURAL = 'plans';

function kubeconfigPath(env: NodeJS.ProcessEnv): string {
  return env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
}

export function realClusterUpgradeOps(env: NodeJS.ProcessEnv): ClusterUpgradeOps {
  async function clients() {
    const [{ createK8sClients }, { existsSync }] = await Promise.all([
      import('../../modules/k8s-provisioner/k8s-client.js'),
      import('node:fs'),
    ]);
    const kc = kubeconfigPath(env);
    return existsSync(kc) ? createK8sClients(kc) : createK8sClients();
  }

  return {
    async readNodeVersions(): Promise<NodeVersion[]> {
      const k8s = await clients();
      const res = (await k8s.core.listNode()) as {
        items?: Array<{
          metadata?: { name?: string; labels?: Record<string, string> };
          status?: { nodeInfo?: { kubeletVersion?: string } };
        }>;
      };
      const items = res.items ?? [];
      return items.map((n) => {
        const labels = n.metadata?.labels ?? {};
        const isServer =
          labels['node-role.kubernetes.io/control-plane'] !== undefined ||
          labels['node-role.kubernetes.io/master'] !== undefined;
        return {
          name: n.metadata?.name ?? '<unknown>',
          role: isServer ? 'server' : 'agent',
          kubeletVersion: n.status?.nodeInfo?.kubeletVersion ?? null,
        };
      });
    },

    async applyPlans(plans): Promise<{ applied: string[] }> {
      const [k8s, { MERGE_PATCH }] = await Promise.all([clients(), import('../../shared/k8s-patch.js')]);
      const applied: string[] = [];
      for (const plan of plans) {
        const meta = (plan as { metadata?: { name?: string } }).metadata ?? {};
        const name = meta.name ?? '<unnamed>';
        const spec = (plan as { spec?: unknown }).spec;
        try {
          // (if a later Plan throws, `applied` already lists the ones that landed,
          //  so the caller can report exactly how far the apply got)
          await k8s.custom.createNamespacedCustomObject({
            group: SUC_GROUP,
            version: SUC_VERSION,
            namespace: SUC_NAMESPACE,
            plural: SUC_PLURAL,
            body: plan,
          } as unknown as Parameters<typeof k8s.custom.createNamespacedCustomObject>[0]);
        } catch (err) {
          const code = (err as { statusCode?: number; code?: number }).statusCode ?? (err as { code?: number }).code;
          if (code !== 409) throw err;
          // Already exists — merge-patch the spec so a re-issued upgrade updates
          // the target version (the v1.4 client only honours MERGE_PATCH via shim).
          await (k8s.custom as unknown as {
            patchNamespacedCustomObject: (
              a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
              mw: typeof MERGE_PATCH,
            ) => Promise<unknown>;
          }).patchNamespacedCustomObject(
            { group: SUC_GROUP, version: SUC_VERSION, namespace: SUC_NAMESPACE, plural: SUC_PLURAL, name, body: { spec } },
            MERGE_PATCH,
          );
        }
        applied.push(name);
      }
      return { applied };
    },
  };
}
