/**
 * cnpg-backup-now — operator-triggered "Backup Now" service.
 *
 * Creates a single CNPG `Backup` CR against the named cluster. The CNPG
 * operator's barman-cloud plugin sidecar handles the actual pg_basebackup
 * + upload to the configured ObjectStore. Returns immediately after the
 * CR is accepted; polling happens client-side via the existing
 * cnpg-backup-catalogue / cnpg-backup-health endpoints.
 *
 * Distinct from postgres-barman-restore.ts:triggerFreshBarmanBackup() —
 * that helper polls synchronously inside the restore orchestrator (the
 * restore needs to know the new backup completed before it can resume).
 * The on-demand pathway is fire-and-forget by design: the operator
 * watches it complete in the UI, not on a request handler thread.
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';
const BARMAN_PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';

// DNS-label-compatible, ≤ 50 chars. Matches the postgres-barman-restore
// guard so a name accepted by one path is accepted by the other.
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export class CnpgBackupNowError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'CnpgBackupNowError';
    this.statusCode = statusCode;
  }
}

function validateName(s: string, label: string): void {
  if (!s || s.length > 50 || !NAME_RE.test(s)) {
    throw new CnpgBackupNowError(
      `Invalid ${label} '${s}' — must be DNS-label-compatible + ≤50 chars`,
      400,
    );
  }
}

export interface CreateBackupNowInput {
  readonly namespace: string;
  readonly clusterName: string;
}

export interface CreateBackupNowResult {
  readonly backupName: string;
  readonly namespace: string;
  readonly clusterName: string;
  readonly createdAt: string;
}

/**
 * Pre-flight: confirm the cluster CR exists + has the barman-cloud
 * plugin attached. Without the plugin, a Backup CR would sit forever
 * in `pending` because no sidecar is listening for it.
 *
 * TOCTOU note: there is a small window between this check and the
 * subsequent createNamespacedCustomObject call during which the
 * operator could remove the plugin from the cluster spec. If that
 * happens the Backup CR is created against a cluster with no
 * listening sidecar and sits in `pending` indefinitely. This is a
 * UX guard, not a security boundary — blast radius is one orphaned
 * Backup CR the operator can `kubectl delete` manually. A k8s
 * admission webhook would close the gap properly but is out of
 * scope for this on-demand pathway.
 */
async function assertClusterEligible(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  clusterName: string,
): Promise<void> {
  let cluster: { spec?: { plugins?: ReadonlyArray<{ name?: string; enabled?: boolean }> } };
  try {
    cluster = await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: 'clusters', name: clusterName,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as typeof cluster;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new CnpgBackupNowError(
        `Cluster ${namespace}/${clusterName} not found`,
        404,
      );
    }
    throw err;
  }

  const plugins = cluster.spec?.plugins ?? [];
  const hasBarman = plugins.some((p) => {
    const n = p?.name ?? '';
    if (p?.enabled === false) return false;
    return n === BARMAN_PLUGIN_NAME
      || n.endsWith('barman-cloud')
      || n.startsWith('barman-cloud.');
  });
  if (!hasBarman) {
    throw new CnpgBackupNowError(
      `Cluster ${namespace}/${clusterName} has no enabled barman-cloud plugin — backups cannot run. Configure WAL Archive on /backups/system?tab=routing to attach the plugin.`,
      409,
    );
  }
}

/**
 * Create a CNPG `Backup` CR. Returns immediately after Kubernetes
 * accepts the object; the operator/sidecar performs the actual backup
 * asynchronously. Caller polls completion via the catalogue endpoint.
 */
export async function createBackupNow(
  custom: k8s.CustomObjectsApi,
  input: CreateBackupNowInput,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<CreateBackupNowResult> {
  validateName(input.namespace, 'namespace');
  validateName(input.clusterName, 'clusterName');

  await assertClusterEligible(custom, input.namespace, input.clusterName);

  // Backup CR names: ≤ 253 chars by k8s convention. `on-demand-` prefix +
  // 13-digit epoch ms gives operators a one-glance "this was on-demand"
  // signal in `kubectl get backups`. Lower-case only to satisfy the
  // RFC1123 DNS-label suffix on barman-uploaded artifact names.
  const backupName = `on-demand-${Date.now()}`;
  const body = {
    apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
    kind: 'Backup',
    metadata: {
      name: backupName,
      namespace: input.namespace,
      labels: {
        // Distinguishes operator-triggered backups from scheduled ones
        // (which are owned by ScheduledBackup CRs) and from pre-restore
        // backups (labelled `barman-pre-restore=true` by the restore
        // orchestrator). Useful for `kubectl get backups -l ...`.
        'platform.phoenix-host.net/on-demand': 'true',
      },
    },
    spec: {
      cluster: { name: input.clusterName },
      method: 'plugin',
      pluginConfiguration: { name: BARMAN_PLUGIN_NAME },
    },
  };

  try {
    await custom.createNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace: input.namespace,
      plural: 'backups', body,
    } as unknown as Parameters<typeof custom.createNamespacedCustomObject>[0]);
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    const msg = (err as Error).message;
    if (code === 409) {
      // Should never collide — the timestamp is unique per ms — but
      // surface it cleanly if k8s ever rejects.
      throw new CnpgBackupNowError(`Backup CR ${backupName} already exists`, 409);
    }
    if (code === 403) {
      throw new CnpgBackupNowError(
        `Forbidden creating Backup CR — platform-api RBAC missing create on backups.postgresql.cnpg.io: ${msg}`,
        500,
      );
    }
    throw err;
  }

  log?.info?.({
    msg: 'cnpg-backup-now: Backup CR created',
    namespace: input.namespace,
    clusterName: input.clusterName,
    backupName,
  });

  return {
    backupName,
    namespace: input.namespace,
    clusterName: input.clusterName,
    createdAt: new Date().toISOString(),
  };
}
