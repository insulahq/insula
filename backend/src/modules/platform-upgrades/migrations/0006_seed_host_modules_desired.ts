/**
 * Platform-migration 0006 — seed the host-modules-desired policy ConfigMap (W10
 * follow-up).
 *
 * Declares the kernel modules the platform keeps LOADED on every node. The
 * host-side `platform-ops host-config` converger reads this and `modprobe`s any
 * missing module (ADDITIVE-ONLY — never unloads), persisting it to
 * /etc/modules-load.d/90-platform.conf so it survives a reboot. Gated on
 * `mode: enforce`.
 *
 * Seeded EMPTY + `mode: observe` so it is a strict no-op until an operator both
 * (a) lists modules and (b) flips the mode to `enforce`. CREATE-IF-ABSENT: a
 * re-run never clobbers operator edits. Idempotent + self-contained + order-stable.
 * Needs a k8s client; with none (e.g. a unit-test boot) it no-ops and is retried
 * on the next boot that has one. Never throws on the absent-client path.
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { PlatformMigration } from '../registry/types.js';

const DESIRED_NAMESPACE = 'platform-system';
const DESIRED_NAME = 'host-modules-desired';

// Seeded empty. The comment block documents the format for the operator who
// edits the CM; comment + blank lines are ignored by the converger.
const DEFAULT_MODULES = `# host-modules-desired — kernel modules the platform keeps LOADED on every node.
# One module name per line (charset [a-z0-9_-], e.g. overlay, br_netfilter).
# ADDITIVE-ONLY: the converger loads missing modules (modprobe) and persists
# them to /etc/modules-load.d/90-platform.conf; it NEVER unloads a module.
#
# OBSERVE MODE (mode: observe below): drift is only reported. Set mode: enforce
# to let the daily host-config timer load missing modules.
#
# Examples:
#   overlay
#   br_netfilter
#   nf_conntrack
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

export const seedHostModulesDesired: PlatformMigration = {
  id: '0006_seed_host_modules_desired',
  version: '2026.6.3',
  description: 'Seed the host-modules-desired ConfigMap (empty, observe-mode) if absent',
  async up(ctx) {
    if (!ctx.k8s) {
      ctx.log.warn('[0006_seed_host_modules_desired] no k8s client at startup — skipping (retried next boot)');
      return;
    }
    if (await configMapExists(ctx.k8s, DESIRED_NAMESPACE, DESIRED_NAME)) {
      ctx.log.info('[0006_seed_host_modules_desired] host-modules-desired already present — leaving operator policy intact');
      return;
    }
    if (ctx.dryRun) {
      ctx.log.info(`[0006_seed_host_modules_desired] would create ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
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
        data: { modules: DEFAULT_MODULES, mode: 'observe' },
      },
    } as unknown as Parameters<typeof ctx.k8s.core.createNamespacedConfigMap>[0]);
    ctx.log.info(`[0006_seed_host_modules_desired] created ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
  },
};
