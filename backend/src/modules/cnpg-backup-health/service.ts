/**
 * CNPG (CloudNative-PG) Backup CR health aggregator.
 *
 * Different from the existing `backup-health` module, which watches
 * tenant-side K8s Jobs labelled `platform.phoenix-host.net/backup-health-watch`.
 * CNPG `Backup` is a separate Custom Resource managed by the CNPG
 * operator — `apiVersion: postgresql.cnpg.io/v1`, `kind: Backup`. It
 * has its own lifecycle (started → running → completed | failed) and
 * is created by `ScheduledBackup` CRs at the configured cron times.
 *
 * Why this matters: on 2026-05-06 a `mail-pg-daily-20260505031500`
 * Backup failed silently because mail-pg's spec.backup section was
 * temporarily unset (during a recovery exercise). Nothing in the
 * platform alerted on it; the failure was only noticed when the
 * operator listed Backup CRs by hand. Phase 2A.2 adds visibility.
 *
 * Pure functions over the K8s API response. The HTTP route in
 * `routes.ts` calls into here and serialises the result. The future
 * scheduler (skipped for MVP) would call into here too and emit
 * notifications when health degrades.
 */

import * as k8s from '@kubernetes/client-node';

const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';
const BACKUP_PLURAL = 'backups';
const SCHEDULED_BACKUP_PLURAL = 'scheduledbackups';
const CLUSTER_PLURAL = 'clusters';

/**
 * Namespaces this module looks at. Hard-coded for the platform's two
 * known CNPG clusters (mail-pg in `mail`, postgres in `platform`).
 * Extend if a future cluster ships a third CNPG database.
 */
export const WATCHED_NAMESPACES: readonly string[] = ['mail', 'platform'];

export type BackupPhase =
  | 'completed'
  | 'failed'
  | 'running'
  | 'started'
  | 'pending'
  | 'unknown';

export type ClusterHealthState =
  | 'healthy'           // last attempt completed, last completed < 24h ago
  | 'stale'             // last attempt completed but > 24h ago — schedule may be misconfigured
  | 'failing'           // last attempt is failed
  | 'never_run'         // no Backup CRs in the namespace for this cluster
  | 'no_backup_config'; // ScheduledBackup CRs exist but cluster has NEITHER spec.backup NOR an enabled barman-cloud plugin

export interface BackupRecord {
  readonly name: string;
  readonly namespace: string;
  readonly clusterName: string;
  readonly method: string;
  readonly phase: BackupPhase;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly error: string | null;
}

export interface ClusterBackupHealth {
  readonly clusterName: string;
  readonly namespace: string;
  readonly state: ClusterHealthState;
  /** Most recent successful backup if any. null if cluster has never had one. */
  readonly lastSuccessfulBackup: BackupRecord | null;
  /** Most recent failed backup more recent than the last success. null if last success > last failure. */
  readonly mostRecentFailure: BackupRecord | null;
  /** Timestamp of last successful backup, in seconds-since-epoch (0 if none). */
  readonly lastSuccessSecondsAgo: number | null;
  /** Names of ScheduledBackup CRs targeting this cluster. */
  readonly scheduledBackups: readonly string[];
  /** Whether the cluster's spec.backup section is set (barmanObjectStore configured). */
  readonly clusterHasBackupSpec: boolean;
}

/**
 * Loose shape of a CNPG Backup CR. Only the fields we read.
 */
interface CnpgBackup {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly creationTimestamp?: string;
  };
  readonly spec?: {
    readonly cluster?: { readonly name?: string };
    readonly method?: string;
  };
  readonly status?: {
    readonly phase?: string;
    readonly startedAt?: string;
    readonly stoppedAt?: string;
    readonly error?: string;
  };
}

interface CnpgScheduledBackup {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
  };
  readonly spec?: {
    readonly cluster?: { readonly name?: string };
  };
}

interface CnpgCluster {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
  };
  readonly spec?: {
    /** Legacy CNPG 1.x backup field (barmanObjectStore inline). Empty
     *  on clusters that have migrated to the plugin model. */
    readonly backup?: unknown;
    /** CNPG 1.21+ plugin model — barman-cloud is a separate
     *  controller referenced here. The presence of an enabled
     *  barman-cloud plugin (any of the canonical plugin names) means
     *  the cluster has backup configured even when spec.backup is
     *  null. */
    readonly plugins?: ReadonlyArray<{
      readonly name?: string;
      readonly enabled?: boolean;
      readonly parameters?: Record<string, unknown>;
    }>;
  };
}

/** Match the plugin name we register with CNPG for barman-cloud. The
 *  canonical name is `barman-cloud.cloudnative-pg.io`; older
 *  registrations may use just `barman-cloud`. */
function hasBarmanCloudPlugin(cluster: CnpgCluster): boolean {
  const plugins = cluster.spec?.plugins ?? [];
  return plugins.some((p) => {
    if (p.enabled === false) return false;
    const n = (p.name ?? '').toLowerCase();
    return n === 'barman-cloud' || n.endsWith('barman-cloud') || n.startsWith('barman-cloud.');
  });
}

interface ListResp<T> {
  items?: T[];
}

const KNOWN_PHASES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'running',
  'started',
  'pending',
]);

function parsePhase(raw: string | undefined): BackupPhase {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  return KNOWN_PHASES.has(lower) ? (lower as BackupPhase) : 'unknown';
}

export interface CnpgBackupHealthTenants {
  readonly custom: k8s.CustomObjectsApi;
}

async function listBackupsInNamespace(
  custom: k8s.CustomObjectsApi,
  namespace: string,
): Promise<CnpgBackup[]> {
  try {
    const resp = await custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace,
      plural: BACKUP_PLURAL,
    } as Parameters<typeof custom.listNamespacedCustomObject>[0]);
    return (resp as ListResp<CnpgBackup>).items ?? [];
  } catch {
    // Namespace may not have CNPG installed; treat as zero backups.
    return [];
  }
}

async function listScheduledBackupsInNamespace(
  custom: k8s.CustomObjectsApi,
  namespace: string,
): Promise<CnpgScheduledBackup[]> {
  try {
    const resp = await custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace,
      plural: SCHEDULED_BACKUP_PLURAL,
    } as Parameters<typeof custom.listNamespacedCustomObject>[0]);
    return (resp as ListResp<CnpgScheduledBackup>).items ?? [];
  } catch {
    return [];
  }
}

async function listClustersInNamespace(
  custom: k8s.CustomObjectsApi,
  namespace: string,
): Promise<CnpgCluster[]> {
  try {
    const resp = await custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace,
      plural: CLUSTER_PLURAL,
    } as Parameters<typeof custom.listNamespacedCustomObject>[0]);
    return (resp as ListResp<CnpgCluster>).items ?? [];
  } catch {
    return [];
  }
}

function toRecord(b: CnpgBackup): BackupRecord | null {
  const name = b.metadata?.name;
  const namespace = b.metadata?.namespace;
  const clusterName = b.spec?.cluster?.name;
  if (!name || !namespace || !clusterName) return null;
  return {
    name,
    namespace,
    clusterName,
    method: b.spec?.method ?? 'unknown',
    phase: parsePhase(b.status?.phase),
    startedAt: b.status?.startedAt ?? b.metadata?.creationTimestamp ?? null,
    stoppedAt: b.status?.stoppedAt ?? null,
    error: b.status?.error ?? null,
  };
}

function compareRecordsDesc(a: BackupRecord, b: BackupRecord): number {
  // Most recent first. Use startedAt; fall back to stoppedAt.
  const aTs = a.startedAt ?? a.stoppedAt ?? '';
  const bTs = b.startedAt ?? b.stoppedAt ?? '';
  return bTs.localeCompare(aTs);
}

export interface SnapshotOptions {
  /** Now-time for staleness calculation. Default Date.now(). */
  readonly nowMs?: number;
  /**
   * Threshold beyond which a "completed" last backup is considered
   * stale. Default 24h. The platform's daily-backup ScheduledBackups
   * mean we expect a fresh completed backup at least every 24h; a
   * gap > threshold suggests the schedule misfired.
   */
  readonly staleAfterMs?: number;
}

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Read CNPG Backup health snapshot across watched namespaces. Returns
 * one entry per CNPG Cluster CR observed.
 */
export async function readBackupHealth(
  tenants: CnpgBackupHealthTenants,
  opts: SnapshotOptions = {},
): Promise<ClusterBackupHealth[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const staleMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;

  const result: ClusterBackupHealth[] = [];

  for (const namespace of WATCHED_NAMESPACES) {
    const [clusters, backups, scheduledBackups] = await Promise.all([
      listClustersInNamespace(tenants.custom, namespace),
      listBackupsInNamespace(tenants.custom, namespace),
      listScheduledBackupsInNamespace(tenants.custom, namespace),
    ]);

    for (const cluster of clusters) {
      const clusterName = cluster.metadata?.name;
      if (!clusterName) continue;

      const clusterBackups = backups
        .map(toRecord)
        .filter((r): r is BackupRecord => r !== null && r.clusterName === clusterName)
        .sort(compareRecordsDesc);

      const lastSuccess = clusterBackups.find((b) => b.phase === 'completed') ?? null;
      const lastAttempt = clusterBackups[0] ?? null;
      const mostRecentFailure =
        lastAttempt && lastAttempt.phase === 'failed'
          ? lastAttempt
          : null;

      const lastSuccessSecondsAgo = lastSuccess?.startedAt
        ? Math.floor((nowMs - new Date(lastSuccess.startedAt).getTime()) / 1000)
        : null;

      // CNPG 1.21+ migrated barman-cloud out of `cluster.spec.backup`
      // into the plugin model (`cluster.spec.plugins[barman-cloud]`).
      // The platform's `system-db` cluster on staging runs the plugin
      // path — its spec.backup is null but it backs up successfully
      // every night. Treat either field shape as "has backup config".
      const legacyBackupSet =
        cluster.spec?.backup !== undefined && cluster.spec.backup !== null;
      const clusterHasBackupSpec = legacyBackupSet || hasBarmanCloudPlugin(cluster);

      const namespacedSchedules = scheduledBackups
        .filter((s) => s.spec?.cluster?.name === clusterName)
        .map((s) => s.metadata?.name ?? '')
        .filter((n) => n !== '');

      let state: ClusterHealthState;
      if (!clusterHasBackupSpec) {
        state = 'no_backup_config';
      } else if (clusterBackups.length === 0) {
        state = 'never_run';
      } else if (mostRecentFailure !== null) {
        state = 'failing';
      } else if (lastSuccess === null) {
        state = 'never_run';
      } else if (
        lastSuccessSecondsAgo !== null &&
        lastSuccessSecondsAgo * 1000 > staleMs
      ) {
        state = 'stale';
      } else {
        state = 'healthy';
      }

      result.push({
        clusterName,
        namespace,
        state,
        lastSuccessfulBackup: lastSuccess,
        mostRecentFailure,
        lastSuccessSecondsAgo,
        scheduledBackups: namespacedSchedules,
        clusterHasBackupSpec,
      });
    }
  }

  return result;
}

// Test-only re-exports for unit testing pure helpers without the
// expensive K8s API tenant.
export const __test = {
  parsePhase,
  toRecord,
  compareRecordsDesc,
};
