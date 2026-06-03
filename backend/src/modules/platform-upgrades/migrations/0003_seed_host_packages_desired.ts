/**
 * Platform-migration 0003 — seed the host-packages-desired policy ConfigMap (W10b).
 *
 * Declares the OS packages the platform keeps PRESENT on every node. The
 * host-side `platform-ops host-config` converger reads this and installs any
 * missing packages (ADDITIVE-ONLY — never removes/purges/downgrades), gated on
 * `mode: enforce`.
 *
 * Seeded EMPTY + `mode: observe` so it is a strict no-op until an operator both
 * (a) lists packages and (b) flips the mode to `enforce`. CREATE-IF-ABSENT: a
 * re-run never clobbers operator edits. Idempotent + self-contained + order-stable.
 * Needs a k8s client; with none (e.g. a unit-test boot) it no-ops and is retried
 * on the next boot that has one. Never throws on the absent-client path.
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { PlatformMigration } from '../registry/types.js';

const DESIRED_NAMESPACE = 'platform-system';
const DESIRED_NAME = 'host-packages-desired';

// Seeded empty. The comment block documents the format for the operator who
// edits the CM; `mode: observe` means even a populated list installs nothing
// until it is flipped to `enforce`.
const DEFAULT_PACKAGES = `# host-packages-desired — OS packages the platform keeps PRESENT on every node.
# One per line: "name" or "name=version" (apt) / "name=version" → name-version (dnf).
# ADDITIVE-ONLY: the converger installs missing packages; it NEVER removes,
# purges, or auto-downgrades. A pin mismatch on an already-installed package is
# reported as drift, never auto-changed.
#
# OBSERVE MODE (mode: observe below): drift is only reported. Set mode: enforce
# to let the daily host-config timer install missing packages.
#
# Examples:
#   jq
#   htop
#   ca-certificates
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

export const seedHostPackagesDesired: PlatformMigration = {
  id: '0003_seed_host_packages_desired',
  version: '2026.6.3',
  description: 'Seed the host-packages-desired ConfigMap (empty, observe-mode) if absent',
  async up(ctx) {
    if (!ctx.k8s) {
      ctx.log.warn('[0003_seed_host_packages_desired] no k8s client at startup — skipping (retried next boot)');
      return;
    }
    if (await configMapExists(ctx.k8s, DESIRED_NAMESPACE, DESIRED_NAME)) {
      ctx.log.info('[0003_seed_host_packages_desired] host-packages-desired already present — leaving operator policy intact');
      return;
    }
    if (ctx.dryRun) {
      ctx.log.info(`[0003_seed_host_packages_desired] would create ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
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
        data: { packages: DEFAULT_PACKAGES, mode: 'observe' },
      },
    } as unknown as Parameters<typeof ctx.k8s.core.createNamespacedConfigMap>[0]);
    ctx.log.info(`[0003_seed_host_packages_desired] created ${DESIRED_NAMESPACE}/${DESIRED_NAME}`);
  },
};
