/**
 * Platform-migration 0004 — seed the host-migrations-desired policy ConfigMap (W10c).
 *
 * The opt-in switch for the host-side host-migration runner. The migration
 * SCRIPTS themselves ship embedded in the platform-ops binary (so they travel
 * with every self-upgrade); this ConfigMap only carries the `mode` that decides
 * whether the daily timer actually RUNS pending scripts (`enforce`) or just
 * reports them (`observe`).
 *
 * Seeded `mode: observe` so the runner is a strict no-op until an operator opts
 * in. CREATE-IF-ABSENT: a re-run never clobbers operator edits. Idempotent +
 * self-contained + order-stable. Never throws on the absent-client path.
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { PlatformMigration } from '../registry/types.js';

const DESIRED_NAMESPACE = 'platform-system';
const DESIRED_NAME = 'host-migrations-desired';

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

export const seedHostMigrationsDesired: PlatformMigration = {
  id: '0004_seed_host_migrations_desired',
  version: '2026.6.3',
  description: 'Seed the host-migrations-desired ConfigMap (observe-mode) if absent',
  async up(ctx) {
    if (!ctx.k8s) {
      ctx.log.warn('[0004_seed_host_migrations_desired] no k8s client at startup — skipping (retried next boot)');
      return;
    }
    if (await configMapExists(ctx.k8s, DESIRED_NAMESPACE, DESIRED_NAME)) {
      ctx.log.info('[0004_seed_host_migrations_desired] host-migrations-desired already present — leaving operator policy intact');
      return;
    }
    if (ctx.dryRun) {
      ctx.log.info(`[0004_seed_host_migrations_desired] would create ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
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
        data: {
          mode: 'observe',
          // Documentation for the operator who edits this CM. Set mode: enforce to
          // let the daily host-config timer run pending host-migration scripts (the
          // scripts ship embedded in the platform-ops binary, applied in version
          // order, halting on the first failure, with per-node markers).
          _note: 'Set mode: enforce to apply shipped host-migration scripts on this node.',
        },
      },
    } as unknown as Parameters<typeof ctx.k8s.core.createNamespacedConfigMap>[0]);
    ctx.log.info(`[0004_seed_host_migrations_desired] created ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
  },
};
