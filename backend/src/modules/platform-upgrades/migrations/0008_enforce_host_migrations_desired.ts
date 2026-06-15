/**
 * Platform-migration 0008 — default host-migrations-desired to ENFORCE.
 *
 * 0004 seeded this gating ConfigMap `mode: observe` (report-only) so the
 * host-migration runner was opt-in. That optionality is removed: the shipped
 * host-migration scripts are platform-authored, CI-validated (idempotent +
 * allow-paths-bounded — ci-host-migrations-check) and embedded in the
 * cosign-SIGNED platform-ops binary, so running them automatically is safe and
 * is what every cluster wants (e.g. the rclone host-dependency backfill in
 * 2026.6.9/0001-install-rclone.sh).
 *
 * Flips `observe` → `enforce` on every cluster (new clusters: right after 0004
 * seeds it; existing clusters: on the upgrade that ships this migration).
 * RESPECTS an operator who already chose `enforce` (no-op) or set some other
 * value (left intact). If the CM is wholesale ABSENT (deleted), recreate it
 * `enforce` so the default holds. Idempotent, self-contained, order-stable.
 *
 * An operator who wants the old report-only behaviour sets `mode: observe`
 * AFTER this runs — the registry executes each migration exactly once, so it
 * will not re-flip that choice.
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { PlatformMigration } from '../registry/types.js';
import { MERGE_PATCH } from '../../../shared/k8s-patch.js';

const DESIRED_NAMESPACE = 'platform-system';
const DESIRED_NAME = 'host-migrations-desired';

interface CmView {
  data?: Record<string, string>;
}

async function readConfigMap(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<CmView | null> {
  try {
    return (await k8s.core.readNamespacedConfigMap({
      name,
      namespace,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as CmView;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err; // a real API error surfaces as a migration failure (halts + retries)
  }
}

export const enforceHostMigrationsDesired: PlatformMigration = {
  id: '0008_enforce_host_migrations_desired',
  version: '2026.6.9',
  description: 'Default host-migrations-desired to enforce (was observe; platform-signed scripts)',
  async up(ctx) {
    if (!ctx.k8s) {
      ctx.log.warn('[0008_enforce_host_migrations_desired] no k8s client at startup — skipping (retried next boot)');
      return;
    }
    const cm = await readConfigMap(ctx.k8s, DESIRED_NAMESPACE, DESIRED_NAME);
    const mode = cm?.data?.mode;
    if (mode === 'enforce') {
      ctx.log.info('[0008_enforce_host_migrations_desired] already enforce — no-op');
      return;
    }
    if (cm && mode !== undefined && mode !== 'observe') {
      ctx.log.info(`[0008_enforce_host_migrations_desired] operator-set mode '${mode}' — leaving intact`);
      return;
    }
    if (ctx.dryRun) {
      ctx.log.info(`[0008_enforce_host_migrations_desired] would set ${DESIRED_NAME} mode=enforce`);
      return;
    }
    if (cm) {
      // Patch ONLY the mode key (preserve _note + any operator-added keys).
      await ctx.k8s.core.patchNamespacedConfigMap(
        {
          name: DESIRED_NAME,
          namespace: DESIRED_NAMESPACE,
          body: { data: { mode: 'enforce' } },
        } as unknown as Parameters<typeof ctx.k8s.core.patchNamespacedConfigMap>[0],
        MERGE_PATCH,
      );
      ctx.log.info(`[0008_enforce_host_migrations_desired] patched ${DESIRED_NAME} mode → enforce`);
      return;
    }
    // Wholesale-absent (deleted) — recreate it enforce.
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
          mode: 'enforce',
          _note: 'Set mode: observe to make the host-migration runner report-only on this node.',
        },
      },
    } as unknown as Parameters<typeof ctx.k8s.core.createNamespacedConfigMap>[0]);
    ctx.log.info(`[0008_enforce_host_migrations_desired] recreated absent ${DESIRED_NAME} mode=enforce`);
  },
};
