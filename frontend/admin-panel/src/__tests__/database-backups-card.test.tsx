/**
 * Tenant → Storage & backups → Database backups, and the fleet card on the
 * tenant backups page: overdue databases are marked, a database that never
 * backed up says "Never", and the last attempt's error is shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminDatabaseBackupStatus } from '@insula/api-contracts';
import DatabaseBackupsCard from '../components/tenant-detail/DatabaseBackupsCard';
import OverdueDatabaseBackupsCard from '../components/backups/OverdueDatabaseBackupsCard';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

function db(over: Partial<AdminDatabaseBackupStatus> = {}): AdminDatabaseBackupStatus {
  return {
    tenantId: 't1', tenantName: 'Acme Ltd', subjectKey: 'dep-1', deploymentId: 'dep-1', deploymentName: 'my-mariadb',
    engine: 'mariadb', instanceLabel: 'my-mariadb (MariaDB)', databaseName: 'shop', databaseLabel: 'shop',
    lastAttemptAt: '2026-11-26T01:50:00.000Z', lastStatus: 'failed', lastError: 'Column count of mysql.proc is wrong',
    lastSuccessAt: null, lastSuccessSizeBytes: null, overdue: true, overdueSince: '2026-11-26T04:00:00.000Z', ...over,
  };
}

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

describe('DatabaseBackupsCard', () => {
  beforeEach(() => apiFetch.mockReset());

  it('lists each database with its last good backup, last attempt and error; overdue ones are marked', async () => {
    apiFetch.mockResolvedValue({ data: { databases: [
      db(),
      db({ databaseName: 'crm', databaseLabel: 'crm', lastStatus: 'dumped', lastError: null, lastSuccessAt: '2026-11-26T01:50:00.000Z', lastSuccessSizeBytes: 2048, overdue: false, overdueSince: null }),
    ] } });
    renderWith(<DatabaseBackupsCard tenantId="t1" />);
    const rows = await screen.findAllByTestId('database-backup-row');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/tenants/t1/database-backups');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('shop')).toBeTruthy();
    expect(within(rows[0]!).getByTestId('database-backup-overdue')).toBeTruthy();
    expect(within(rows[0]!).getByText('Never')).toBeTruthy();
    expect(within(rows[0]!).getByTestId('database-backup-error').textContent).toBe('Column count of mysql.proc is wrong');
    expect(within(rows[1]!).queryByTestId('database-backup-overdue')).toBeNull();
    expect(within(rows[1]!).getByText('Backed up')).toBeTruthy();
    expect(screen.getByTestId('database-backups-overdue-count').textContent).toBe('1 overdue');
  });

  it('says when no database has been recorded yet', async () => {
    apiFetch.mockResolvedValue({ data: { databases: [] } });
    renderWith(<DatabaseBackupsCard tenantId="t1" />);
    expect(await screen.findByText(/No databases recorded yet/)).toBeTruthy();
  });
});

describe('OverdueDatabaseBackupsCard', () => {
  beforeEach(() => apiFetch.mockReset());

  it('lists overdue databases across tenants, naming each tenant', async () => {
    apiFetch.mockResolvedValue({ data: { databases: [db(), db({ tenantId: 't2', tenantName: 'Beta GmbH' })] } });
    renderWith(<OverdueDatabaseBackupsCard />);
    const card = await screen.findByTestId('overdue-database-backups-card');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/database-backups/overdue');
    expect(within(card).getByText(/Database backups overdue \(2\)/)).toBeTruthy();
    expect(within(card).getByText('Beta GmbH')).toBeTruthy();
  });

  it('renders nothing when nothing is overdue', async () => {
    apiFetch.mockResolvedValue({ data: { databases: [] } });
    const { container } = renderWith(<OverdueDatabaseBackupsCard />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="overdue-database-backups-card"]')).toBeNull();
  });
});
