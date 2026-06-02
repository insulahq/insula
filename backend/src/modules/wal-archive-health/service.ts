/**
 * WAL-archive health reader + archiving-disable primitive (I/O side).
 *
 * Reads the live facts the scheduler assesses:
 *  - barman plugin presence + CNPG `ContinuousArchiving` condition (Cluster CR)
 *  - data-volume size (Cluster spec.storage.size)
 *  - pg_wal bytes (pg_ls_waldir() — the app role is a pg_monitor member, so
 *    this is permitted and is the ACCURATE current size, shrinking as WAL
 *    recycles, unlike a thin-provisioned volume's high-water actualSize).
 */
import { sql } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import {
  CNPG_API_GROUP,
  CNPG_API_VERSION,
  CLUSTER_PLURAL,
  POSTGRES_NAMESPACE,
  POSTGRES_CLUSTER_NAME,
  BARMAN_PLUGIN_NAME,
  ensureClusterBarmanPlugin,
} from '../backup-rclone-shim/postgres-objectstore.js';
import type { WalArchiveSnapshot } from './health.js';

interface ClusterCRView {
  spec?: {
    plugins?: Array<{ name?: string }>;
    storage?: { size?: string };
  };
  status?: {
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

/** Parse a k8s quantity like "20Gi" / "500Mi" / "1000000000" to bytes. */
export function parseStorageQuantity(q: string | undefined): number {
  if (!q) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTPE]i?|[KMGTPE]|)$/.exec(q.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] || '';
  const mult: Record<string, number> = {
    '': 1,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  };
  return Math.round(n * (mult[unit] ?? 1));
}

export interface ReadWalArchiveDeps {
  readonly db: Database;
  readonly custom: k8s.CustomObjectsApi;
  readonly log: Pick<Logger, 'warn'>;
}

/**
 * Read a health snapshot, or null if the Cluster CR isn't present yet
 * (fresh install before Flux applies database.yaml) — caller skips the tick.
 */
export async function readWalArchiveHealth(deps: ReadWalArchiveDeps): Promise<WalArchiveSnapshot | null> {
  let cluster: ClusterCRView;
  try {
    cluster = (await deps.custom.getNamespacedCustomObject({
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: CLUSTER_PLURAL,
      name: POSTGRES_CLUSTER_NAME,
    } as unknown as Parameters<typeof deps.custom.getNamespacedCustomObject>[0])) as ClusterCRView;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) {
      deps.log.warn({ err: err instanceof Error ? err.message : String(err) },
        'wal-archive-health: could not read Cluster CR — skipping tick');
    }
    return null;
  }

  const plugins = cluster.spec?.plugins ?? [];
  const barmanPluginPresent = plugins.some((p) => p.name === BARMAN_PLUGIN_NAME);
  const ca = (cluster.status?.conditions ?? []).find((c) => c.type === 'ContinuousArchiving');
  // Healthy unless CNPG EXPLICITLY reports False — avoids false alarms in the
  // window after the plugin attaches but before the first archive is reported.
  const continuousArchivingHealthy = ca?.status !== 'False';
  const volumeBytes = parseStorageQuantity(cluster.spec?.storage?.size);

  let walBytes = 0;
  try {
    const res = await deps.db.execute<{ wal_bytes: string | number }>(
      sql`SELECT COALESCE(sum(size), 0)::bigint AS wal_bytes FROM pg_ls_waldir()`,
    );
    walBytes = Number((res.rows?.[0]?.wal_bytes) ?? 0);
  } catch (err) {
    // Permission/transient error → pressure becomes 0 → alert-only (never trips).
    deps.log.warn({ err: err instanceof Error ? err.message : String(err) },
      'wal-archive-health: pg_ls_waldir() failed — pressure unknown, trip disabled this tick');
  }

  return {
    clusterName: POSTGRES_CLUSTER_NAME,
    barmanPluginPresent,
    continuousArchivingHealthy,
    walBytes,
    volumeBytes,
  };
}

/** Immediately detach the barman archiver (the breaker's hard action). */
export async function disableWalArchiving(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  await ensureClusterBarmanPlugin(custom, log, false);
}
