/**
 * Backups → Database backups (tenant panel): the tenant sees each of its
 * databases, when it was last backed up, and what kind of failure the last
 * attempt was — never the error text itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DatabaseBackupStatus } from '@insula/api-contracts';
import DatabaseBackupsCard from '../components/DatabaseBackupsCard';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));

function db(over: Partial<DatabaseBackupStatus> = {}): DatabaseBackupStatus {
  return {
    subjectKey: 'dep-1', deploymentId: 'dep-1', deploymentName: 'my-mariadb', engine: 'mariadb',
    instanceLabel: 'my-mariadb (MariaDB)', instanceState: 'active', databaseName: 'shop', databaseLabel: 'shop',
    lastAttemptAt: '2026-11-26T01:50:00.000Z', lastStatus: 'failed', lastErrorKind: 'not_running',
    lastErrorLabel: 'The database was not running.',
    lastSuccessAt: '2026-11-20T01:50:00.000Z', lastSuccessSizeBytes: 100, overdue: true, overdueSince: '2026-11-21T04:00:00.000Z', ...over,
  };
}
const page = (data: DatabaseBackupStatus[], cursor: string | null = null) =>
  ({ data, pagination: { cursor, has_more: cursor !== null, page_size: 100, total_count: 0 } });

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><DatabaseBackupsCard /></MemoryRouter></QueryClientProvider>);
}

describe('tenant DatabaseBackupsCard', () => {
  beforeEach(() => apiFetch.mockReset());

  it('reads the tenant route and marks overdue databases with the kind of failure', async () => {
    apiFetch.mockResolvedValue(page([db(), db({ databaseName: 'blog', databaseLabel: 'blog', lastStatus: 'dumped', lastErrorKind: null, lastErrorLabel: null, overdue: false, overdueSince: null })]));
    renderCard();
    const rows = await screen.findAllByTestId('tenant-database-backup-row');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/tenant/backups/databases');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Overdue')).toBeTruthy();
    expect(within(rows[0]!).getByTestId('tenant-database-backup-error').textContent).toBe('The database was not running.');
    expect(within(rows[1]!).queryByText('Overdue')).toBeNull();
    expect(screen.getByTestId('tenant-database-backups-overdue').textContent).toBe('1 overdue');
  });

  it('says when an instance is stopped', async () => {
    apiFetch.mockResolvedValue(page([db({ instanceState: 'stopped', overdue: false, overdueSince: null })]));
    renderCard();
    expect((await screen.findByTestId('tenant-database-backup-instance-state')).textContent).toBe('Stopped');
  });

  it('loads the next page on request', async () => {
    apiFetch
      .mockResolvedValueOnce(page([db()], 'c1'))
      .mockResolvedValueOnce(page([db({ databaseName: 'crm', databaseLabel: 'crm' })]));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-database-backups-show-more'));
    await waitFor(() => expect(screen.getAllByTestId('tenant-database-backup-row')).toHaveLength(2));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/v1/tenant/backups/databases?cursor=c1');
    expect(screen.queryByTestId('tenant-database-backups-show-more')).toBeNull();
  });

  it('a failed load shows the error panel instead of nothing', async () => {
    apiFetch.mockRejectedValueOnce(new Error('boom'));
    renderCard();
    expect(await screen.findByTestId('tenant-database-backups-error-panel')).toBeTruthy();
  });

  it('a database never backed up says so; a tenant with no databases sees no card at all', async () => {
    apiFetch.mockResolvedValueOnce(page([db({ lastSuccessAt: null, lastSuccessSizeBytes: null })]));
    const first = renderCard();
    expect(await screen.findByText('Never')).toBeTruthy();
    first.unmount();
    apiFetch.mockResolvedValueOnce(page([]));
    const { container } = renderCard();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('[data-testid="tenant-database-backups"]')).toBeNull());
  });
});
