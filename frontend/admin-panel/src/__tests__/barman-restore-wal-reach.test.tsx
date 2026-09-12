/**
 * The restore wizard must not start a restore the archive cannot deliver.
 *
 * Point-in-time recovery replays the WAL forward and stops at the first segment
 * the archive cannot produce. Before this, the wizard's "WAL coverage" panel
 * said *"PITR target can roll forward to that point"* on the strength of the
 * last-archived timestamp alone — its own comment admitted it was "assuming
 * continuous WAL archive coverage". Nothing checked that assumption, so an
 * operator could ask for a time on the far side of a hole and watch the restore
 * fail partway through, during an incident.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

import BarmanRestoreWizard from '../components/backups/BarmanRestoreWizard';

const CLUSTER = 'system-db';
const STORE = 'system-postgres-objectstore';

const HEALTH = [{
  clusterName: CLUSTER, namespace: 'platform', state: 'healthy',
  lastSuccessfulBackup: { name: 'b', phase: 'completed', startedAt: '2026-09-11T03:00:00Z', stoppedAt: '2026-09-11T03:00:27Z', error: null },
  mostRecentFailure: null, lastSuccessSecondsAgo: 3600,
  scheduledBackups: ['sb'], clusterHasBackupSpec: true,
  objectStoreBackupCount: 2, instances: 1, objectStoreName: STORE,
}];

const WAL_CLUSTER = {
  clusterNamespace: 'platform', clusterName: CLUSTER,
  enabled: true, walArchivingActive: true, effectiveArchiveTimeout: '5min',
  state: null,
  status: {
    firstRecoverabilityPoint: '2026-08-24T19:30:00Z',
    lastArchivedWal: '000000010000002200000063',
    lastArchivedWalTime: '2026-09-12T00:00:00Z',
    lastFailedArchiveTime: null, lastFailedArchiveError: null,
    archivedCount: 5389, failedCount: 0, statsResetAt: '2026-08-27T12:39:06Z',
    archivingHealthySince: '2026-08-12T22:45:32Z',
  },
};

const INTACT = {
  state: 'ready', measuredAt: '2026-09-12T00:10:00Z',
  gaps: [], continuousSince: '2026-08-24T19:30:00Z', continuousUntil: '2026-09-12T00:00:00Z',
  continuityInconclusive: false, timelines: [1],
  segmentCount: 5389, totalBytes: 90_000_000_000,
  oldestAt: '2026-08-24T19:30:00Z', newestAt: '2026-09-12T00:00:00Z',
  truncated: false, readError: null, queryDurationMs: 900,
};

/** A hole: the chain only reaches 2026-09-05. */
const BROKEN = {
  ...INTACT,
  gaps: [{ afterSegment: '000000010000001500000002', beforeSegment: '000000010000001500000009', missingCount: 6, timeline: 1 }],
  continuousUntil: '2026-09-05T12:00:00Z',
};

function routeApi(walSummary: unknown) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('/wal-summary')) return Promise.resolve({ data: walSummary });
    if (path.includes('/cnpg-backup-health')) return Promise.resolve({ data: HEALTH });
    if (path.includes('/wal-archive/clusters')) return Promise.resolve({ data: [WAL_CLUSTER] });
    if (path.includes('/cnpg-backup-catalogue')) {
      return Promise.resolve({ data: {
        source: 'object-store', objectStoreName: STORE, namespace: 'platform',
        backups: [{ backupId: '20260911T030000', startedAt: '2026-09-11T03:00:00Z', endedAt: '2026-09-11T03:00:27Z', status: 'DONE', beginWal: null, endWal: null, clusterSizeBytes: null, dataSizeBytes: 3e9, uploadedAt: '2026-09-11T03:00:30Z', parseError: null }],
        unavailableReason: null, queryDurationMs: 100, walSummary: null, partial: false,
      } });
    }
    return Promise.resolve({ data: [] });
  });
}

function renderWizard(initialTarget: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BarmanRestoreWizard
          initialSourceName={CLUSTER}
          initialTargetTime={initialTarget}
          onClose={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Click through to the confirm step. */
async function toConfirm() {
  for (let i = 0; i < 2; i += 1) {
    const next = await screen.findByTestId('barman-restore-wizard-next');
    fireEvent.click(next);
  }
  return screen.findByTestId('barman-restore-wizard-start');
}

describe('restore wizard vs a broken WAL chain', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('refuses to start a restore targeting a time past the break', async () => {
    routeApi(BROKEN);
    renderWizard('2026-09-10T12:00:00Z'); // past continuousUntil (09-05)
    const start = await toConfirm();
    await waitFor(() => expect(start).toBeDisabled());
    expect(await screen.findByTestId('barman-restore-target-unreachable'))
      .toHaveTextContent(/cannot succeed/);
  });

  it('names how much is missing and the last point it can reach', async () => {
    routeApi(BROKEN);
    renderWizard('2026-09-10T12:00:00Z');
    await toConfirm();
    const gap = await screen.findByTestId('barman-restore-wal-gap');
    expect(gap).toHaveTextContent(/6 WAL segment\(s\) missing/);
    expect(gap).toHaveTextContent(/Replay stops at the first absent segment/);
  });

  it('allows a target BEFORE the break', async () => {
    routeApi(BROKEN);
    renderWizard('2026-09-01T12:00:00Z'); // before continuousUntil
    const start = await toConfirm();
    await waitFor(() => expect(start).toBeEnabled());
    expect(screen.queryByTestId('barman-restore-target-unreachable')).toBeNull();
    // …but the gap is still disclosed, because it bounds any later attempt.
    expect(screen.getByTestId('barman-restore-wal-gap')).toBeInTheDocument();
  });

  it('does not block or warn when the chain is intact', async () => {
    routeApi(INTACT);
    renderWizard('2026-09-11T12:00:00Z');
    const start = await toConfirm();
    await waitFor(() => expect(start).toBeEnabled());
    expect(screen.queryByTestId('barman-restore-wal-gap')).toBeNull();
    expect(screen.queryByTestId('barman-restore-target-unreachable')).toBeNull();
  });

  it('warns but does NOT block when continuity could not be established', async () => {
    // During an incident, refusing a restore on a suspicion we cannot justify is
    // worse than letting the operator proceed with the caveat in front of them.
    routeApi({ ...INTACT, gaps: [], continuityInconclusive: true });
    renderWizard('2026-09-11T12:00:00Z');
    const start = await toConfirm();
    await waitFor(() => expect(start).toBeEnabled());
    expect(await screen.findByTestId('barman-restore-wal-unknown'))
      .toHaveTextContent(/whether every WAL segment is\s+present is unknown/);
  });
});
