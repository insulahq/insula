/**
 * The platform database's own backups (CNPG Backup CRs) as backup-health rows.
 *
 * The Backups page's System card counted only the labelled DR Jobs (etcd,
 * cluster state, secrets), so the database that holds every tenant's
 * configuration could fail its backups while the card read healthy. The
 * dashboard's Backups & DR card already reads CNPG; this puts the same source
 * on the Backups page, one row per CNPG cluster, in the System ('dr') class.
 */
import type * as k8s from '@kubernetes/client-node';
import { readBackupHealth, type ClusterBackupHealth } from '../cnpg-backup-health/service.js';
import type { BackupHealthSummary } from './service.js';

const when = (r: { stoppedAt: string | null; startedAt: string | null } | null): Date | null => {
  const iso = r ? (r.stoppedAt ?? r.startedAt) : null;
  return iso ? new Date(iso) : null;
};

function rowFor(c: ClusterBackupHealth): BackupHealthSummary {
  const base = {
    groupKey: `cnpg:${c.namespace}/${c.clusterName}`,
    displayName: `Platform database (${c.clusterName})`,
    namespace: c.namespace,
    category: 'dr' as const,
    tenantId: null,
    lastSuccessAt: when(c.lastSuccessfulBackup),
    lastFailedAt: when(c.mostRecentFailure),
    recentRuns: (c.lastSuccessfulBackup ? 1 : 0) + (c.mostRecentFailure ? 1 : 0),
  };
  switch (c.state) {
    case 'healthy':
      return { ...base, state: 'healthy', severity: 'info', lastFailedReason: null };
    case 'failing':
      return { ...base, state: 'failing', severity: 'critical', lastFailedReason: c.mostRecentFailure?.error ?? 'the last database backup failed' };
    case 'stale': {
      const hours = c.lastSuccessSecondsAgo == null ? null : Math.round(c.lastSuccessSecondsAgo / 3600);
      return { ...base, state: 'failing', severity: 'warning', lastFailedReason: `no database backup completed for ${hours ?? 'over 24'} h — check the ScheduledBackup` };
    }
    case 'cnpg_operator_blind':
      return { ...base, state: 'failing', severity: 'warning', lastFailedReason: 'backups exist in the object store but the CNPG operator reports none — the backup plugin is not working' };
    case 'no_backup_config':
      return { ...base, state: 'never_run', severity: 'warning', lastFailedReason: 'no backup target is configured for the platform database' };
    case 'never_run':
    default:
      return { ...base, state: 'never_run', severity: 'warning', lastFailedReason: null };
  }
}

export function cnpgHealthRows(clusters: readonly ClusterBackupHealth[]): BackupHealthSummary[] {
  return clusters.map(rowFor);
}

/** Never throws: an unreadable CNPG status is itself shown as a failing System row. */
export async function loadCnpgHealthRows(
  clients: { readonly custom: k8s.CustomObjectsApi; readonly core?: k8s.CoreV1Api },
): Promise<BackupHealthSummary[]> {
  try {
    return cnpgHealthRows(await readBackupHealth(clients));
  } catch (err) {
    return [{
      groupKey: 'cnpg:unavailable',
      displayName: 'Platform database',
      namespace: 'platform',
      category: 'dr',
      severity: 'warning',
      tenantId: null,
      state: 'failing',
      lastSuccessAt: null,
      lastFailedAt: null,
      lastFailedReason: `could not read the database backup status: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      recentRuns: 0,
    }];
  }
}
