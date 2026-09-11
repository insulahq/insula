/**
 * The two System-Backups surfaces must not contradict each other about WAL.
 *
 * Operator report 2026-09-11: the Database Backup Health card showed a green
 * "WAL streaming" chip while Backups → System → WAL archive said streaming was
 * not enabled. The cluster had never had streaming enabled (audit log) and was
 * archiving a segment every five minutes anyway, because scheduled base backups
 * attach the barman-cloud plugin and the plugin's PRESENCE is what makes CNPG
 * archive.
 *
 * So the fixture below is the production state: plugin attached, no explicit
 * archive_timeout, scheduled backups on.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WalArchiveCluster } from '@insula/api-contracts';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

import { CnpgBackupHealthCard } from '../components/CnpgBackupHealthCard';
import WalArchiveTab from '../components/system-backup/WalArchiveTab';

const PROD_STATE: WalArchiveCluster = {
  clusterNamespace: 'platform',
  clusterName: 'system-db',
  enabled: true,
  walArchivingActive: true,
  walArchivingSource: 'scheduled_backups',
  effectiveArchiveTimeout: '5min',
  state: {
    targetConfigId: 't1',
    targetName: 'system-target',
    retentionDays: 30,
    destinationPath: 's3://system/wal-archive/platform-system-db',
    enabledAt: '2026-08-24T19:24:08.000Z',
    archiveTimeout: null,
    baseBackupSchedule: '0 0 3 * * *',
    baseBackupRetentionDays: null,
    baseBackupStatus: { lastScheduleTime: '2026-09-11T03:00:00Z', nextScheduleTime: '2026-09-12T03:00:00Z' },
  },
  status: {
    firstRecoverabilityPoint: '2026-08-24T19:30:00Z',
    lastArchivedWal: '0000000100000021000000BB',
    lastArchivedWalTime: '2026-09-11T20:14:31.046Z',
    lastFailedArchiveTime: null,
    lastFailedArchiveError: null,
    archivedCount: 4477,
    failedCount: 64,
    statsResetAt: '2026-08-27T12:39:06.098Z',
    archivingHealthySince: '2026-08-12T22:45:32Z',
  },
};

function streamingState(): WalArchiveCluster {
  return {
    ...PROD_STATE,
    walArchivingSource: 'streaming',
    effectiveArchiveTimeout: '60s',
    state: { ...PROD_STATE.state!, archiveTimeout: '60s' },
  };
}

function offState(): WalArchiveCluster {
  return {
    ...PROD_STATE,
    enabled: false,
    walArchivingActive: false,
    walArchivingSource: 'none',
    effectiveArchiveTimeout: null,
    state: null,
    status: { ...PROD_STATE.status!, lastArchivedWalTime: null, lastArchivedWal: null },
  };
}

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function routeApi(cluster: WalArchiveCluster) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('/wal-archive/clusters')) return Promise.resolve({ data: [cluster] });
    if (path.includes('/cnpg-backup-health')) {
      // Shape per CnpgClusterBackupHealth — a FLAT array in `data`.
      return Promise.resolve({ data: [{
        clusterName: 'system-db',
        namespace: 'platform',
        state: 'healthy',
        lastSuccessfulBackup: {
          name: 'system-db-scheduled-backup-20260911030000',
          phase: 'completed',
          startedAt: '2026-09-11T03:00:00Z',
          stoppedAt: '2026-09-11T03:00:27Z',
          error: null,
        },
        mostRecentFailure: null,
        lastSuccessSecondsAgo: 3600,
        scheduledBackups: ['system-db-scheduled-backup'],
        clusterHasBackupSpec: true,
        objectStoreBackupCount: 3,
        instances: 1,
      }] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe('WAL chip on the Database Backup Health card', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('does NOT claim "WAL streaming" when archiving is only implied by base backups', async () => {
    routeApi(PROD_STATE);
    renderWith(<CnpgBackupHealthCard />);
    expect(await screen.findByTestId('cnpg-wal-badge-implied')).toHaveTextContent('WAL archiving (implied)');
    expect(screen.queryByTestId('cnpg-wal-badge-streaming')).toBeNull();
  });

  it('says "WAL streaming" only when an explicit archive_timeout is configured', async () => {
    routeApi(streamingState());
    renderWith(<CnpgBackupHealthCard />);
    expect(await screen.findByTestId('cnpg-wal-badge-streaming')).toBeInTheDocument();
  });

  it('does not render "WAL failing" for a failure that later archives overtook', async () => {
    // DEV's real counters: 64 lifetime failures, the last one three days before
    // the last success. pg_stat_archiver keeps it forever; the backend only
    // fills lastFailedArchiveTime when nothing was archived since. This asserts
    // the UI contract that goes with that.
    routeApi(PROD_STATE);
    renderWith(<CnpgBackupHealthCard />);
    await screen.findByTestId('cnpg-wal-badge-implied');
    expect(screen.queryByTestId('cnpg-wal-badge-failing')).toBeNull();
  });

  it('says WAL off when the plugin entry is gone', async () => {
    routeApi(offState());
    renderWith(<CnpgBackupHealthCard />);
    expect(await screen.findByTestId('cnpg-wal-badge-disabled')).toBeInTheDocument();
  });
});

describe('WAL archive settings tab', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('tells the operator archiving is running even though streaming is off', async () => {
    routeApi(PROD_STATE);
    renderWith(<WalArchiveTab />);
    const banner = await screen.findByTestId('wal-archiving-implied-system-db');
    expect(banner).toHaveTextContent('WAL is being archived right now');
    expect(banner).toHaveTextContent('5min');
    // and the section header must not read a bare "disabled"
    expect(screen.getByTestId('section-implied-badge')).toHaveTextContent('archiving (implied)');
  });

  it('shows the REAL last-archive instant, not the health-condition transition', async () => {
    routeApi(PROD_STATE);
    renderWith(<WalArchiveTab />);
    const cell = await screen.findByTestId('wal-last-archived-system-db');
    // pg_stat_archiver: 2026-09-11. The ContinuousArchiving condition transition
    // is 2026-08-12 and used to be rendered here as "last WAL archived".
    expect(cell.textContent).toMatch(/2026/);
    expect(cell).toHaveTextContent('4477 archived');
    expect(cell.textContent).not.toMatch(/Aug 12|8\/12\/2026/);
  });

  it('names the effective RPO as CNPG default when streaming was never configured', async () => {
    routeApi(PROD_STATE);
    renderWith(<WalArchiveTab />);
    const cell = await screen.findByTestId('wal-effective-timeout-system-db');
    expect(cell).toHaveTextContent('5min');
    expect(cell).toHaveTextContent('CNPG default');
  });

  it('names a bare SYSTEM target binding rather than blaming a schedule', async () => {
    // DEV's shape: no state row, plugin attached by the shim, WAL flowing.
    routeApi({
      ...PROD_STATE,
      walArchivingSource: 'target_binding',
      state: null,
    });
    renderWith(<WalArchiveTab />);
    const banner = await screen.findByTestId('wal-archiving-implied-system-db');
    expect(banner).toHaveTextContent('SYSTEM backup target is bound');
    expect(banner.textContent).not.toMatch(/scheduled base backups attach/);
  });

  it('does not show the implied banner once streaming is configured', async () => {
    routeApi(streamingState());
    renderWith(<WalArchiveTab />);
    await screen.findByTestId('wal-effective-timeout-system-db');
    expect(screen.queryByTestId('wal-archiving-implied-system-db')).toBeNull();
  });
});
