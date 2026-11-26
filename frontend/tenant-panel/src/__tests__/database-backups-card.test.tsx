/**
 * Backups → Database backups (tenant panel): the tenant sees each of its
 * databases, when it was last backed up, and why the last attempt failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DatabaseBackupStatus } from '@insula/api-contracts';
import DatabaseBackupsCard from '../components/DatabaseBackupsCard';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

function db(over: Partial<DatabaseBackupStatus> = {}): DatabaseBackupStatus {
  return {
    subjectKey: 'dep-1', deploymentId: 'dep-1', deploymentName: 'my-mariadb', engine: 'mariadb',
    instanceLabel: 'my-mariadb (MariaDB)', databaseName: 'shop', databaseLabel: 'shop',
    lastAttemptAt: '2026-11-26T01:50:00.000Z', lastStatus: 'failed', lastError: 'dump failed',
    lastSuccessAt: '2026-11-20T01:50:00.000Z', lastSuccessSizeBytes: 100, overdue: true, overdueSince: '2026-11-21T04:00:00.000Z', ...over,
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><DatabaseBackupsCard /></MemoryRouter></QueryClientProvider>);
}

describe('tenant DatabaseBackupsCard', () => {
  beforeEach(() => apiFetch.mockReset());

  it('reads the tenant route and marks overdue databases with their error', async () => {
    apiFetch.mockResolvedValue({ data: { databases: [db(), db({ databaseName: 'blog', databaseLabel: 'blog', lastStatus: 'dumped', lastError: null, overdue: false, overdueSince: null })] } });
    renderCard();
    const rows = await screen.findAllByTestId('tenant-database-backup-row');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/tenant/backups/databases');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Overdue')).toBeTruthy();
    expect(within(rows[0]!).getByTestId('tenant-database-backup-error').textContent).toBe('dump failed');
    expect(within(rows[1]!).queryByText('Overdue')).toBeNull();
    expect(screen.getByTestId('tenant-database-backups-overdue').textContent).toBe('1 overdue');
  });

  it('a database never backed up says so', async () => {
    apiFetch.mockResolvedValue({ data: { databases: [db({ lastSuccessAt: null, lastSuccessSizeBytes: null })] } });
    renderCard();
    expect(await screen.findByText('Never')).toBeTruthy();
  });

  it('a tenant with no databases sees no card at all', async () => {
    apiFetch.mockResolvedValue({ data: { databases: [] } });
    const { container } = renderCard();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="tenant-database-backups"]')).toBeNull());
  });
});
