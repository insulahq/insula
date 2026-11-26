import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Backups from '../pages/Backups';
import { useTenantBundles } from '../hooks/use-tenant-backups';

// The Backups page was rewritten to read from the new tenant-backup
// endpoints (use-tenant-backups). The legacy /api/v1/tenants/:id/backups
// hook is no longer used. The detailed list-rendering / sorting tests
// from the legacy version are now exercised end-to-end by the
// integration-staging restore scenario; the surface-level "page renders
// without throwing" smoke is preserved here.

vi.mock('../hooks/use-tenant-backups', () => ({
  useTenantBundles: vi.fn(() => ({ data: { data: [] }, isLoading: false, isError: false })),
  useTenantRestoreCarts: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useDeleteRestoreCart: vi.fn(() => ({
    mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null,
  })),
  useRunBundleNow: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isSuccess: false, error: null })),
  downloadTenantDataExport: vi.fn(),
  useTenantDatabaseBackups: vi.fn(() => ({ data: { data: { databases: [] } }, isLoading: false, isError: false })),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Backups page (tenant-backup self-service)', () => {
  it('renders the heading + description', () => {
    render(<Backups />, { wrapper });
    expect(screen.getByTestId('backups-heading')).toBeInTheDocument();
  });

  it('shows the empty state when there are no bundles', () => {
    render(<Backups />, { wrapper });
    expect(screen.getByTestId('backups-empty')).toBeInTheDocument();
  });

  it('marks a completed bundle in which not every database dumped', () => {
    const bundle = (id: string, dumps: 'ok' | 'degraded') => ({
      id, tenantId: 't1', status: 'completed', initiator: 'system', label: id, sizeBytes: 10, resticAddedBytes: 5,
      createdAt: '2026-11-26T01:50:00.000Z', expiresAt: '2026-12-26T01:50:00.000Z', exportArtifact: null,
      databaseDumps: { status: dumps, deployments: [] },
    });
    vi.mocked(useTenantBundles).mockReturnValue({
      data: { data: [bundle('bkp-good', 'ok'), bundle('bkp-bad', 'degraded')] }, isLoading: false, isError: false,
    } as unknown as ReturnType<typeof useTenantBundles>);
    render(<Backups />, { wrapper });
    expect(screen.getByTestId('bundle-db-dumps-degraded-bkp-bad')).toHaveTextContent('Not every database dumped');
    expect(screen.queryByTestId('bundle-db-dumps-degraded-bkp-good')).toBeNull();
  });
});
