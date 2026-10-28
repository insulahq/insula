/**
 * The mail card's size is restic's count of what the kept snapshots use — not
 * the repository on the target, which the class total above it shows.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemBackupsOverview } from '@insula/api-contracts';

vi.mock('@/lib/api-client', () => ({ API_BASE: 'http://localhost:3000', apiFetch: vi.fn() }));
const MailObjectBackupCard = (await import('@/components/backups/MailObjectBackupCard')).default;

const overview = (totalSnapshotSizeBytes: number) => ({
  objectBackups: {
    mail: { targetName: 'StorageBox', snapshotCount: 48, totalSnapshotSizeBytes, lastRunAt: '2026-10-28T09:37:17.020Z', secondsSinceLastRun: 600 },
  },
}) as unknown as SystemBackupsOverview;

const renderIt = (ov: SystemBackupsOverview) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter><MailObjectBackupCard ov={ov} loading={false} /></MemoryRouter>
  </QueryClientProvider>,
);

describe('MailObjectBackupCard', () => {
  it('labels restic’s figure for what it counts, in decimal GB, and says why the folder is larger', () => {
    // Production: 46.5 GB in use by 48 snapshots; it read "Total repo size 43.30 GiB".
    renderIt(overview(46_491_882_262));
    const stats = screen.getByTestId('mail-object-backup-stats');
    expect(stats).toHaveTextContent('Used by kept snapshots46.5 GB');
    expect(stats).not.toHaveTextContent(/Total repo size|GiB/);
    expect(screen.getByTestId('mail-object-backup-size-note')).toHaveTextContent(/repository on the target is larger/);
  });

  it('shows no figure, not 0 B, when restic stats failed', () => {
    renderIt(overview(0));
    expect(screen.getByTestId('mail-object-backup-stats')).toHaveTextContent('Used by kept snapshotsnot measured');
  });
});
