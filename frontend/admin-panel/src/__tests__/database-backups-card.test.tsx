/**
 * Tenant → Storage & backups → Database backups, and the fleet card on the
 * tenant backups page: overdue databases are marked, stopped instances say
 * so, the last attempt shows its kind and its text, lists page, and a failed
 * load is shown rather than hidden.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminDatabaseBackupStatus } from '@insula/api-contracts';
import DatabaseBackupsCard from '../components/tenant-detail/DatabaseBackupsCard';
import OverdueDatabaseBackupsCard from '../components/backups/OverdueDatabaseBackupsCard';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));

function db(over: Partial<AdminDatabaseBackupStatus> = {}): AdminDatabaseBackupStatus {
  return {
    tenantId: 't1', tenantName: 'Acme Ltd', subjectKey: 'dep-1', deploymentId: 'dep-1', deploymentName: 'my-mariadb',
    engine: 'mariadb', instanceLabel: 'my-mariadb (MariaDB)', instanceState: 'active', databaseName: 'shop', databaseLabel: 'shop',
    lastAttemptAt: '2026-11-26T01:50:00.000Z', lastStatus: 'failed', lastErrorKind: 'other',
    lastErrorLabel: 'The database reported an error while it was being dumped.', lastError: 'Column count of mysql.proc is wrong',
    lastSuccessAt: null, lastSuccessSizeBytes: null, overdue: true, overdueSince: '2026-11-26T04:00:00.000Z', ...over,
  };
}
const page = (data: AdminDatabaseBackupStatus[], cursor: string | null = null) =>
  ({ data, pagination: { cursor, has_more: cursor !== null, page_size: 100, total_count: 0 } });

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

describe('DatabaseBackupsCard', () => {
  beforeEach(() => apiFetch.mockReset());

  it('lists each database with its last good backup, last attempt, kind and error; overdue and stopped are marked', async () => {
    apiFetch.mockResolvedValue(page([
      db(),
      db({ databaseName: 'crm', databaseLabel: 'crm', lastStatus: 'dumped', lastError: null, lastErrorKind: null, lastErrorLabel: null, lastSuccessAt: '2026-11-26T01:50:00.000Z', lastSuccessSizeBytes: 2048, overdue: false, overdueSince: null, instanceState: 'stopped' }),
    ]));
    renderWith(<DatabaseBackupsCard tenantId="t1" />);
    const rows = await screen.findAllByTestId('database-backup-row');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/tenants/t1/database-backups');
    expect(within(rows[0]!).getByTestId('database-backup-overdue')).toBeTruthy();
    expect(within(rows[0]!).getByText('Never')).toBeTruthy();
    expect(within(rows[0]!).getByTestId('database-backup-error-kind').textContent).toBe('The database reported an error while it was being dumped.');
    expect(within(rows[0]!).getByTestId('database-backup-error').textContent).toBe('Column count of mysql.proc is wrong');
    expect(within(rows[1]!).getByTestId('database-backup-instance-state').textContent).toBe('Stopped');
    expect(screen.getByTestId('database-backups-overdue-count').textContent).toBe('1 overdue');
  });

  it('loads the next page on request', async () => {
    apiFetch.mockResolvedValueOnce(page([db()], 'c1')).mockResolvedValueOnce(page([db({ databaseName: 'crm', databaseLabel: 'crm' })]));
    renderWith(<DatabaseBackupsCard tenantId="t1" />);
    fireEvent.click(await screen.findByTestId('database-backups-show-more'));
    await waitFor(() => expect(screen.getAllByTestId('database-backup-row')).toHaveLength(2));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/v1/admin/tenants/t1/database-backups?cursor=c1');
  });

  it('a failed load is an error panel, and an empty one says when rows will appear', async () => {
    apiFetch.mockRejectedValueOnce(new Error('boom'));
    const first = renderWith(<DatabaseBackupsCard tenantId="t1" />);
    expect(await screen.findByTestId('database-backups-error-panel')).toBeTruthy();
    first.unmount();
    apiFetch.mockResolvedValueOnce(page([]));
    renderWith(<DatabaseBackupsCard tenantId="t1" />);
    expect(await screen.findByText(/No databases recorded yet/)).toBeTruthy();
  });
});

describe('OverdueDatabaseBackupsCard', () => {
  beforeEach(() => apiFetch.mockReset());

  it('lists overdue databases across tenants, naming each tenant', async () => {
    apiFetch.mockResolvedValue(page([db(), db({ tenantId: 't2', tenantName: 'Beta GmbH' })]));
    renderWith(<OverdueDatabaseBackupsCard />);
    const card = await screen.findByTestId('overdue-database-backups-card');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/database-backups/overdue');
    expect(within(card).getByText(/Database backups overdue \(2\)/)).toBeTruthy();
    expect(within(card).getByText('Beta GmbH')).toBeTruthy();
  });

  it('renders nothing when nothing is overdue, and an error when it cannot tell', async () => {
    apiFetch.mockResolvedValueOnce(page([]));
    const first = renderWith(<OverdueDatabaseBackupsCard />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(first.container.querySelector('[data-testid="overdue-database-backups-card"]')).toBeNull();
    first.unmount();
    apiFetch.mockRejectedValueOnce(new Error('boom'));
    renderWith(<OverdueDatabaseBackupsCard />);
    expect(await screen.findByTestId('overdue-database-backups-error')).toBeTruthy();
  });
});
