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
import { listBackupsFromObjectStore } from '../cnpg-backup-catalogue/service.js';

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
  | 'no_backup_config'  // ScheduledBackup CRs exist but cluster has NEITHER spec.backup NOR an enabled barman-cloud plugin
  | 'cnpg_operator_blind'; // CNPG returned no Backup CRs but the object store has backups — operator/plugin is broken

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
  /** Phase 2 — when the cluster references a barman-cloud plugin AND the
   *  CNPG operator has returned zero Backup CRs, the catalogue enrichment
   *  surfaces what's actually in the object store. Null when CNPG sees its
   *  own backups (normal happy path). */
  readonly objectStoreBackupCount?: number | null;
  /** Phase 4 (2026-05-22) — current cluster instance count (HA replica
   *  count). Lets the barman-restore wizard auto-default a side-by-side
   *  restore to the source's HA state instead of always 1. */
  readonly instances?: number | null;
  /** The barman-cloud ObjectStore the cluster archives to (plugin mode).
   *  Populated when hasBarmanCloudPlugin(cluster) returns true; null
   *  otherwise. Used by the Health Card to deep-link into the catalogue. */
  readonly objectStoreName?: string | null;
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
    /** Current HA replica count. Used to auto-default barman-restore
     *  side-by-side cluster size to the source's HA state. */
    readonly instances?: number;
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

/** Read the ObjectStore name from the cluster's barman-cloud plugin
 *  parameters. Returns null when the cluster doesn't use the plugin or
 *  doesn't carry a barmanObjectName parameter. */
export function getBarmanObjectStoreName(cluster: CnpgCluster): string | null {
  const plugins = cluster.spec?.plugins ?? [];
  for (const p of plugins) {
    if (p.enabled === false) continue;
    const n = (p.name ?? '').toLowerCase();
    if (n !== 'barman-cloud' && !n.endsWith('barman-cloud') && !n.startsWith('barman-cloud.')) continue;
    const v = p.parameters?.barmanObjectName;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
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
  /** Optional — when supplied, readBackupHealth can ask the catalogue
   *  (object-store source-of-truth) whether a cluster's barman-cloud
   *  archive contains backups even though the CNPG operator returned
   *  none. Used to upgrade `never_run` → `cnpg_operator_blind`. */
  readonly core?: k8s.CoreV1Api;
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
  /** Optional pino-shaped logger for catalogue-enrichment diagnostics.
   *  When omitted, catalogue failures stay silent (callers from the
   *  route handler pass `request.log` for breadcrumbs). */
  readonly log?: { readonly warn?: (obj: object, msg: string) => void };
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

      // Phase 2 — Object-store enrichment. If the cluster says
      // `never_run` or `failing` but the catalogue can prove the
      // archive has backups, the CNPG operator's projection has
      // diverged from reality. Upgrade the state to surface this.
      // Only ask the catalogue when the cluster is on the plugin
      // model (cheap precondition: avoid extra k8s API calls for
      // legacy clusters).
      let objectStoreBackupCount: number | null | undefined = undefined;
      if (tenants.core && (state === 'never_run' || state === 'failing') && hasBarmanCloudPlugin(cluster)) {
        const objStore = getBarmanObjectStoreName(cluster);
        if (objStore) {
          try {
            const cat = await listBackupsFromObjectStore(tenants.core, tenants.custom, namespace, objStore);
            if (cat.source === 'object-store') {
              objectStoreBackupCount = cat.backups.length;
              if (cat.backups.length > 0) {
                state = 'cnpg_operator_blind';
              }
            } else if (opts.log) {
              opts.log.warn?.({ namespace, clusterName, objStore, reason: cat.unavailableReason }, 'cnpg-backup-health: catalogue unavailable; state stays at base');
            }
          } catch (err) {
            // Best-effort enrichment; failure must not break the
            // primary health response — but log so an operator
            // debugging cnpg_operator_blind has a breadcrumb.
            opts.log?.warn?.(
              { err: err instanceof Error ? err.message : String(err), namespace, clusterName, objStore },
              'cnpg-backup-health: catalogue probe threw; using base state',
            );
          }
        }
      }

      const objectStoreName = hasBarmanCloudPlugin(cluster) ? getBarmanObjectStoreName(cluster) : null;
      result.push({
        clusterName,
        namespace,
        state,
        lastSuccessfulBackup: lastSuccess,
        mostRecentFailure,
        lastSuccessSecondsAgo,
        scheduledBackups: namespacedSchedules,
        clusterHasBackupSpec,
        ...(objectStoreBackupCount !== undefined ? { objectStoreBackupCount } : {}),
        instances: cluster.spec?.instances ?? null,
        objectStoreName,
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
