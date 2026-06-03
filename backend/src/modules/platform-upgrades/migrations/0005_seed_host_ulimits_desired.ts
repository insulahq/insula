/**
 * Platform-migration 0005 — seed the host-ulimits-desired policy ConfigMap (W10
 * follow-up).
 *
 * Declares the PAM `limits.conf` lines the platform renders into a single managed
 * drop-in (/etc/security/limits.d/90-platform.conf) on every node. The host-side
 * `platform-ops host-config` converger reads this, validates each line, and
 * writes the drop-in when it drifts — gated on `mode: enforce`.
 *
 * Seeded EMPTY + `mode: observe` so it is a strict no-op until an operator both
 * (a) lists limits and (b) flips the mode to `enforce`. CREATE-IF-ABSENT: a
 * re-run never clobbers operator edits. Idempotent + self-contained + order-stable.
 * Needs a k8s client; with none (e.g. a unit-test boot) it no-ops and is retried
 * on the next boot that has one. Never throws on the absent-client path.
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { PlatformMigration } from '../registry/types.js';

const DESIRED_NAMESPACE = 'platform-system';
const DESIRED_NAME = 'host-ulimits-desired';

// Seeded empty. The comment block documents the format for the operator who
// edits the CM; comment + blank lines are ignored by the converger.
const DEFAULT_LIMITS = `# host-ulimits-desired — PAM limits.conf lines the platform keeps on every node.
# Rendered VERBATIM into the managed drop-in /etc/security/limits.d/90-platform.conf
# (a separate file — the converger overwrites it wholesale, never your other
# limits.d files). One line per limit: "<domain> <type> <item> <value>".
#   <domain> = user | @group | %group | * (wildcard)
#   <type>   = soft | hard | -
#   <item>   = nofile | nproc | memlock | stack | …
#   <value>  = a number | unlimited | -1
# A malformed line is DROPPED (reported), never written.
#
# OBSERVE MODE (mode: observe below): drift is only reported. Set mode: enforce
# to let the daily host-config timer write the drop-in.
#
# Examples:
#   * soft nofile 65536
#   * hard nofile 65536
#   root - memlock unlimited
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

export const seedHostUlimitsDesired: PlatformMigration = {
  id: '0005_seed_host_ulimits_desired',
  version: '2026.6.3',
  description: 'Seed the host-ulimits-desired ConfigMap (empty, observe-mode) if absent',
  async up(ctx) {
    if (!ctx.k8s) {
      ctx.log.warn('[0005_seed_host_ulimits_desired] no k8s client at startup — skipping (retried next boot)');
      return;
    }
    if (await configMapExists(ctx.k8s, DESIRED_NAMESPACE, DESIRED_NAME)) {
      ctx.log.info('[0005_seed_host_ulimits_desired] host-ulimits-desired already present — leaving operator policy intact');
      return;
    }
    if (ctx.dryRun) {
      ctx.log.info(`[0005_seed_host_ulimits_desired] would create ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
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
        data: { limits: DEFAULT_LIMITS, mode: 'observe' },
      },
    } as unknown as Parameters<typeof ctx.k8s.core.createNamespacedConfigMap>[0]);
    ctx.log.info(`[0005_seed_host_ulimits_desired] created ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
  },
};
