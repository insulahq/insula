/**
 * Host-migration preview (ADR-045 W14 follow-up). The migration SCRIPTS are
 * embedded in the platform-ops binary (they travel with each release), so the
 * backend cannot list the actual pending scripts. It surfaces the one thing it
 * CAN read from the cluster: the `host-migrations-desired` ConfigMap mode, i.e.
 * whether nodes apply host-migrations at all — and says WHEN they do. They do not
 * run during the upgrade: a node applies a release's host changes once its own
 * CLI updates to that release, on the node's daily update timer.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { HostMigrationsPreviewResponse } from '@insula/api-contracts';

const DESIRED_NS = 'platform-system';
const HOST_MIGRATIONS_CM = 'host-migrations-desired';

/** Pure: map a raw CM mode string to the preview shape. */
export function interpretHostMigrationMode(rawMode: string | null): HostMigrationsPreviewResponse {
  if (rawMode === null) {
    return { mode: 'absent', willRun: false, note: 'No host-migration policy — nodes will not apply host changes.' };
  }
  const mode = rawMode.trim().toLowerCase();
  if (mode === 'enforce') {
    return {
      mode: 'enforce',
      willRun: true,
      note: 'Enabled — each node applies this release\'s host changes when its own CLI updates to the release, '
        + 'on the node\'s daily update timer (up to ~25 h after the services). The Host migrations card shows each node.',
    };
  }
  if (mode === 'observe' || mode === '') {
    return { mode: 'observe', willRun: false, note: 'Observe mode — nodes report what would change; nothing runs until the policy is set to enforce.' };
  }
  return { mode: 'unknown', willRun: false, note: `Unrecognised host-migration mode "${mode.slice(0, 32)}".` };
}

export async function readHostMigrationsPreview(k8s: K8sClients): Promise<HostMigrationsPreviewResponse> {
  try {
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: HOST_MIGRATIONS_CM,
      namespace: DESIRED_NS,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as { data?: Record<string, string> };
    return interpretHostMigrationMode(cm.data?.['mode'] ?? '');
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode ?? (err as { code?: number })?.code;
    if (code === 404) return interpretHostMigrationMode(null); // CM absent → no policy
    return { mode: 'unknown', willRun: false, note: 'Could not read the host-migration policy (cluster unreachable).' };
  }
}
