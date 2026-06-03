/**
 * Platform-migration 0002 — seed the host-config-desired policy ConfigMap.
 *
 * The first CLUSTER-touching platform-migration: it ensures the
 * `host-config-desired` ConfigMap exists with sane default sysctls so the
 * (observe-only) host-config-reconciler DaemonSet has a policy to diff against.
 *
 * CREATE-IF-ABSENT: if the ConfigMap already exists it is left untouched —
 * operators own the policy after the first seed; a re-run never clobbers their
 * edits. Idempotent + self-contained + order-stable. Needs a k8s client; with
 * none (e.g. a unit-test boot) it no-ops and is retried on the next boot that
 * has one. Never throws on the absent-client path.
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { PlatformMigration } from '../registry/types.js';

const DESIRED_NAMESPACE = 'platform-system';
const DESIRED_NAME = 'host-config-desired';

// Conservative defaults — only keys inside the reconciler's allow-list
// (net/vm/fs/kernel). fs.inotify watches/instances matter for the many
// file-watching workloads (Vite dev, log shippers); vm.max_map_count for
// search/db engines; net.core.somaxconn for accept-queue depth under load.
const DEFAULT_SYSCTLS = `# host-config-desired — sysctls the platform expects on every node.
# OBSERVE MODE: the host-config-reconciler reports drift against these; it does
# NOT write them. Edit freely — a platform upgrade will not overwrite this CM.
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 8192
vm.max_map_count = 262144
net.core.somaxconn = 1024
`;

async function configMapExists(k8s: K8sClients, namespace: string, name: string): Promise<boolean> {
  try {
    await k8s.core.readNamespacedConfigMap({
      name,
      namespace,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0]);
    return true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) return false;
    throw err; // a real API error surfaces as a migration failure (halts + retries)
  }
}

export const seedHostConfigDesired: PlatformMigration = {
  id: '0002_seed_host_config_desired',
  version: '2026.6.2',
  description: 'Seed the host-config-desired ConfigMap (observe-mode policy) if absent',
  async up(ctx) {
    if (!ctx.k8s) {
      ctx.log.warn('[0002_seed_host_config_desired] no k8s client at startup — skipping (retried next boot)');
      return;
    }
    if (await configMapExists(ctx.k8s, DESIRED_NAMESPACE, DESIRED_NAME)) {
      ctx.log.info('[0002_seed_host_config_desired] host-config-desired already present — leaving operator policy intact');
      return;
    }
    if (ctx.dryRun) {
      ctx.log.info(`[0002_seed_host_config_desired] would create ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
      return;
    }
    await ctx.k8s.core.createNamespacedConfigMap({
      namespace: DESIRED_NAMESPACE,
      body: {
        metadata: {
          name: DESIRED_NAME,
          namespace: DESIRED_NAMESPACE,
          labels: {
            app: 'host-config-reconciler',
            'app.kubernetes.io/part-of': 'hosting-platform',
          },
        },
        data: { sysctls: DEFAULT_SYSCTLS },
      },
    } as unknown as Parameters<typeof ctx.k8s.core.createNamespacedConfigMap>[0]);
    ctx.log.info(`[0002_seed_host_config_desired] created ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
  },
};
