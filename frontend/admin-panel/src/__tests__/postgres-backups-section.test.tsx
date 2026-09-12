/**
 * Platform-database backups: ONE switch, three settings, and a status block
 * that reports what the archive actually holds.
 *
 * Replaces `wal-archiving-truth.test.tsx` (2026-09-11). That file pinned an
 * intermediate design where WAL archiving could be "implied" — active while the
 * panel's own toggle said off. The operator's verdict was that the split should
 * not exist at all: a base backup is unrestorable without the WAL written
 * during it, so offsite backups are on or off together. These tests pin the
 * replacement, including the absence of the things that confused them.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WalArchiveCluster } from '@insula/api-contracts';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

import PostgresBackupsSection from '../components/system-backup/PostgresBackupsSection';
import { CnpgBackupHealthCard } from '../components/CnpgBackupHealthCard';

const ON: WalArchiveCluster = {
  clusterNamespace: 'platform',
  clusterName: 'system-db',
  enabled: true,
  walArchivingActive: true,
  effectiveArchiveTimeout: '5min',
  state: {
    targetConfigId: 't1',
    targetName: 'system-target',
    retentionDays: 30,
    destinationPath: 's3://system/wal-archive/platform-system-db',
    enabledAt: '2026-08-24T19:24:08.000Z',
    archiveTimeout: '5min',
    baseBackupSchedule: '0 0 3 * * *',
    baseBackupRetentionDays: null,
    baseBackupStatus: {
      lastScheduleTime: '2026-09-11T03:00:00.000Z',
      nextScheduleTime: '2026-09-12T03:00:00.000Z',
    },
  },
  status: {
    firstRecoverabilityPoint: '2026-08-24T19:30:00.000Z',
    lastArchivedWal: '0000000100000021000000BB',
    lastArchivedWalTime: '2026-09-11T20:14:31.046Z',
    lastFailedArchiveTime: null,
    lastFailedArchiveError: null,
    archivedCount: 4472,
    failedCount: 64,
    statsResetAt: '2026-08-27T12:39:06.098Z',
    archivingHealthySince: '2026-09-08T08:51:41.000Z',
  },
};

const OFF: WalArchiveCluster = {
  ...ON,
  enabled: false,
  walArchivingActive: false,
  effectiveArchiveTimeout: null,
  state: null,
  status: { ...ON.status!, lastArchivedWalTime: null, lastArchivedWal: null },
};

const CATALOGUE = {
  source: 'object-store',
  objectStoreName: 'system-postgres-objectstore',
  namespace: 'platform',
  unavailableReason: null,
  queryDurationMs: 120,
  backups: [
    { backupId: '20260910T030000', startedAt: '2026-09-10T03:00:00Z', endedAt: '2026-09-10T03:00:27Z', status: 'DONE', beginWal: null, endWal: null, clusterSizeBytes: null, dataSizeBytes: 3_000_000_000, uploadedAt: '2026-09-10T03:00:30Z', parseError: null },
    { backupId: '20260911T030000', startedAt: '2026-09-11T03:00:00Z', endedAt: '2026-09-11T03:00:27Z', status: 'DONE', beginWal: null, endWal: null, clusterSizeBytes: null, dataSizeBytes: 3_100_000_000, uploadedAt: '2026-09-11T03:00:30Z', parseError: null },
  ],
  walSummary: null,
  partial: false,
};

/** The separate, cheap WAL endpoint. */
const WAL_SUMMARY = {
  state: 'ready' as const,
  measuredAt: '2026-09-12T00:10:00.000Z',
  segmentCount: 812,
  totalBytes: 3_400_000_000,
  oldestAt: '2026-08-24T19:30:00Z',
  newestAt: '2026-09-11T20:14:31Z',
  truncated: false,
  readError: null,
  queryDurationMs: 900,
};

function routeApi(cluster: WalArchiveCluster, opts: {
  bound?: boolean;
  walSummary?: Record<string, unknown> | 'reject';
  catalogue?: 'reject' | typeof CATALOGUE;
} = {}) {
  const bound = opts.bound ?? true;
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('/wal-archive/clusters')) return Promise.resolve({ data: [cluster] });
    if (path.includes('/backup-rclone-shim/assignments') || path.includes('/assignments')) {
      return Promise.resolve({ data: { assignments: [{
        className: 'system',
        targetId: bound ? 't1' : null,
        targetName: bound ? 'system-target' : null,
        targetStorageType: 's3',
        drainTimeoutSeconds: 300,
      }] } });
    }
    if (path.includes('/cnpg-backup-health')) {
      return Promise.resolve({ data: [{
        clusterName: 'system-db', namespace: 'platform', state: 'healthy',
        lastSuccessfulBackup: { name: 'b', phase: 'completed', startedAt: '2026-09-11T03:00:00Z', stoppedAt: '2026-09-11T03:00:27Z', error: null },
        mostRecentFailure: null, lastSuccessSecondsAgo: 3600,
        scheduledBackups: ['sb'], clusterHasBackupSpec: true,
        objectStoreBackupCount: 2, instances: 1,
        objectStoreName: 'system-postgres-objectstore',
      }] });
    }
    if (path.includes('/wal-summary')) {
      if (opts.walSummary === 'reject') return Promise.reject(new Error('shim unreachable'));
      return Promise.resolve({ data: opts.walSummary ?? WAL_SUMMARY });
    }
    if (path.includes('/cnpg-backup-catalogue')) {
      if (opts.catalogue === 'reject') return Promise.reject(new Error('catalogue failed'));
      return Promise.resolve({ data: opts.catalogue ?? CATALOGUE });
    }
    return Promise.resolve({ data: [] });
  });
}

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Platform database backups card', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('offers exactly one switch and three settings — no separate WAL toggle', async () => {
    routeApi(ON);
    renderWith(<PostgresBackupsSection />);
    await screen.findByTestId('pg-backups-system-db');

    expect(screen.getByTestId('pg-cadence-system-db')).toBeInTheDocument();
    expect(screen.getByTestId('pg-archive-timeout-system-db')).toBeInTheDocument();
    expect(screen.getByTestId('pg-retention-system-db')).toBeInTheDocument();
    expect(screen.getByTestId('pg-disable-system-db')).toHaveTextContent('Turn off offsite backups');

    // The things the operator asked to be gone.
    expect(screen.queryByTestId('wal-streaming-disable-system-db')).toBeNull();
    expect(screen.queryByTestId('wal-archiving-implied-system-db')).toBeNull();
    expect(screen.queryByTestId('section-implied-badge')).toBeNull();
    expect(document.body.textContent).not.toMatch(/implied/i);
  });

  it('says plainly whether offsite backups are on', async () => {
    routeApi(ON);
    renderWith(<PostgresBackupsSection />);
    expect(await screen.findByTestId('pg-backups-state')).toHaveTextContent('Offsite backups on');
  });

  it('when off, shows one enable button and no status block', async () => {
    routeApi(OFF);
    renderWith(<PostgresBackupsSection />);
    expect(await screen.findByTestId('pg-enable-system-db')).toHaveTextContent('Turn on offsite backups');
    expect(screen.queryByTestId('pg-status-system-db')).toBeNull();
    expect(screen.queryByTestId('pg-disable-system-db')).toBeNull();
  });

  it('blocks enabling until a storage target is bound, and says why', async () => {
    routeApi(OFF, { bound: false });
    renderWith(<PostgresBackupsSection />);
    const btn = await screen.findByTestId('pg-enable-system-db');
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('pg-backups-state')).toHaveTextContent('No storage target bound');
    expect(document.body.textContent).toMatch(/Bind a system storage target/);
  });
});

describe('Status block — what the archive holds', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('reports the restorable window, not just the last backup', async () => {
    routeApi(ON);
    renderWith(<PostgresBackupsSection />);
    const w = await screen.findByTestId('pg-window-system-db');
    expect(w).toHaveTextContent(/→ now/);
    expect(w).toHaveTextContent(/day/);
  });

  it('reports WAL upload health with a success rate', async () => {
    routeApi(ON);
    renderWith(<PostgresBackupsSection />);
    const wal = await screen.findByTestId('pg-wal-system-db');
    expect(wal).toHaveTextContent(/last upload/);
    // 4472 of 4536 = 98.6%
    expect(wal).toHaveTextContent(/98\.6%/);
    expect(wal).toHaveTextContent(/4472 ok, 64 retried/);
  });

  it('reports storage used, split into base copies and log segments', async () => {
    routeApi(ON);
    renderWith(<PostgresBackupsSection />);
    const s = await screen.findByTestId('pg-storage-system-db');
    // 3.0 + 3.1 GB of base copies plus 3.4 GB of log = 8.85 GiB total; the
    // panel formats in binary units. Arrives with the catalogue query.
    await waitFor(() => expect(s.textContent).toMatch(/8\.85 GiB/));
    expect(s).toHaveTextContent(/base copies/);
    expect(s).toHaveTextContent(/812 segments/);
  });

  it('serves the previous figures while a refresh runs, with their age', async () => {
    routeApi(ON, { walSummary: { ...WAL_SUMMARY, state: 'measuring' } });
    renderWith(<PostgresBackupsSection />);
    const s = await screen.findByTestId('pg-storage-system-db');
    await waitFor(() => expect(s).toHaveTextContent(/8\.85 GiB/));
    expect(s).toHaveTextContent(/measured/);
    expect(s).toHaveTextContent(/refreshing/);
  });

  it('says the first measurement is under way instead of claiming zero', async () => {
    routeApi(ON, { walSummary: { ...WAL_SUMMARY, state: 'measuring', measuredAt: null, segmentCount: 0, totalBytes: 0 } });
    renderWith(<PostgresBackupsSection />);
    const s = await screen.findByTestId('pg-storage-system-db');
    await waitFor(() => expect(s).toHaveTextContent(/measuring/));
    expect(s.textContent).not.toMatch(/could not measure/);
  });

  it('does not promise a recovery window when there is log but no base backup', async () => {
    // Retained WAL with nothing underneath it restores NOTHING. Using the
    // oldest segment as the floor would have told the operator they could
    // recover to a point they cannot.
    routeApi(
      { ...ON, status: { ...ON.status!, firstRecoverabilityPoint: null } },
      { catalogue: { ...CATALOGUE, backups: [], partial: false } },
    );
    renderWith(<PostgresBackupsSection />);
    const w = await screen.findByTestId('pg-window-system-db');
    await waitFor(() => expect(w).toHaveTextContent(/nothing restorable yet/));
    expect(w.textContent).not.toMatch(/→ now/);
  });

  it('does not call an archive empty when the listing timed out before reading it', async () => {
    // Seen on DEV: the listing hit its deadline with zero entries read, and the
    // card said "nothing restorable yet — the first base backup has not run".
    // That is a claim about the operator's DR position that nobody verified.
    // No firstRecoverabilityPoint either — CNPG's own figure would (rightly)
    // answer the question when it has one.
    routeApi(
      { ...ON, status: { ...ON.status!, firstRecoverabilityPoint: null } },
      { catalogue: { ...CATALOGUE, backups: [], partial: true } },
    );
    renderWith(<PostgresBackupsSection />);
    const w = await screen.findByTestId('pg-window-system-db');
    await waitFor(() => expect(w).toHaveTextContent(/listing timed out/));
    expect(w.textContent).not.toMatch(/nothing restorable yet/);
    expect(await screen.findByTestId('pg-base-system-db')).toHaveTextContent(/timed out before any were read/);
  });

  it('still reports base copies when the log cannot be listed', async () => {
    // Some targets cannot enumerate the log prefix in any reasonable time —
    // rclone itself could not on DEV. Throwing away the base figure we DO have
    // would be the worse answer.
    routeApi(ON, { walSummary: { ...WAL_SUMMARY, state: 'error', measuredAt: null, readError: 'timed out' } });
    renderWith(<PostgresBackupsSection />);
    const s = await screen.findByTestId('pg-storage-system-db');
    await waitFor(() => expect(s).toHaveTextContent(/base copies only/));
    expect(s).toHaveTextContent(/5\.68 GiB/);
    expect(s).toHaveTextContent(/log volume not counted/);
    expect(s.textContent).not.toMatch(/could not measure/);
  });

  it('says it could not measure rather than spinning forever', async () => {
    // The failure this replaces: the storage cell sat on "measuring…" because
    // the catalogue call ran for minutes through the storage shim.
    routeApi(ON, { walSummary: 'reject', catalogue: 'reject' });
    renderWith(<PostgresBackupsSection />);
    const s = await screen.findByTestId('pg-storage-system-db');
    await waitFor(() => expect(s).toHaveTextContent(/could not measure/));
    // The restorable window still resolves — CNPG reports its own floor, so a
    // storage read failure must not blank out an answer we already have.
    const w = await screen.findByTestId('pg-window-system-db');
    expect(w).toHaveTextContent(/→ now/);
  });

  it('admits it cannot read the archive when nothing else knows the floor', async () => {
    routeApi(
      { ...ON, status: { ...ON.status!, firstRecoverabilityPoint: null } },
      { walSummary: 'reject', catalogue: 'reject' },
    );
    renderWith(<PostgresBackupsSection />);
    const w = await screen.findByTestId('pg-window-system-db');
    await waitFor(() => expect(w).toHaveTextContent(/could not read the archive/));
  });

  it('marks the figures as a floor when the walk was cut short', async () => {
    routeApi(ON, { walSummary: { ...WAL_SUMMARY, truncated: true } });
    renderWith(<PostgresBackupsSection />);
    const s = await screen.findByTestId('pg-storage-system-db');
    await waitFor(() => expect(s).toHaveTextContent(/or more/));
    expect(s).toHaveTextContent(/812\+ segments/);
  });

  it('reports base-backup cadence status, including the next run', async () => {
    routeApi(ON);
    renderWith(<PostgresBackupsSection />);
    const b = await screen.findByTestId('pg-base-system-db');
    expect(b).toHaveTextContent(/last/);
    expect(b).toHaveTextContent(/next/);
    await waitFor(() => expect(b).toHaveTextContent(/2 kept offsite/));
  });
});

describe('WAL chip on the health card', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('is green "WAL archiving" while segments are reaching the target', async () => {
    routeApi(ON);
    renderWith(<CnpgBackupHealthCard />);
    expect(await screen.findByTestId('cnpg-wal-badge-streaming')).toHaveTextContent('WAL archiving');
    expect(screen.queryByTestId('cnpg-wal-badge-implied')).toBeNull();
  });

  it('does not cry failure over a failure later uploads overtook', async () => {
    // 64 lifetime failures, none newer than the last success: the backend only
    // fills lastFailedArchiveTime when nothing was archived since.
    routeApi(ON);
    renderWith(<CnpgBackupHealthCard />);
    await screen.findByTestId('cnpg-wal-badge-streaming');
    expect(screen.queryByTestId('cnpg-wal-badge-failing')).toBeNull();
  });

  it('says backups are off when nothing is being archived', async () => {
    routeApi(OFF);
    renderWith(<CnpgBackupHealthCard />);
    expect(await screen.findByTestId('cnpg-wal-badge-disabled')).toHaveTextContent('Backups off');
  });
});
