/**
 * Backups pause while a tenant is suspended: the Tenant Backups page says so,
 * will not start a bundle for it, and "Bundle all eligible tenants" leaves it
 * out — the API would refuse each with 409 TENANT_SUSPENDED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

const ACTIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUSPENDED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = (tenantId: string, tenantName: string, backupsPaused: boolean) => ({
  tenantId, tenantName, backupsPaused, includedInScheduledBundles: true, scheduledBundlesOverride: 'inherit',
  bundleCount: 3, bundleBytes: 0, repoTotalBytes: null, repoStatsAt: null, repoVerifiedAt: null, repoTotalSource: null,
  snapshotCount: 0, snapshotBytes: 0, lastSnapshotAt: null, lastBundleAt: null, snapshotQuotaPct: null,
  openCartId: null, isSystem: false, planName: 'Starter',
});
const ROLLUP = [row(ACTIVE, 'Acme', false), row(SUSPENDED, 'Paused Co', true)];

const apiFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  if (url.includes('/admin/backups/tenants/overview')) return { data: { rows: ROLLUP, kpi: {}, generatedAt: '' } };
  if (url === '/api/v1/admin/tenant-bundles' && init?.method === 'POST') return { data: { bundleId: 'bkp-new', status: 'running' } };
  if (url.includes('/admin/tenant-bundles')) return { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 100 } };
  if (url.includes('/admin/backups/tenants/snapshots')) return { data: { rows: [] } };
  return { data: [] };
});
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...(a as [string, { method?: string; body?: string }?])) }));
vi.mock('@/hooks/use-backup-rclone-shim', () => ({
  useShimAssignments: () => ({ data: { data: { assignments: [{ className: 'tenant', targetId: 'target-1' }] } } }),
}));

const Page = (await import('@/pages/backups/TenantsBackupsPage')).default;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Page /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { apiFetch.mockClear(); });

describe('a suspended tenant on the Tenant Backups page', () => {
  it('reads "paused — suspended" and cannot be backed up from its row', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`inclusion-state-${SUSPENDED}`)).toBeInTheDocument());
    expect(screen.getByTestId(`inclusion-state-${SUSPENDED}`)).toHaveTextContent('paused — suspended');
    expect(screen.getByTestId(`inclusion-state-${ACTIVE}`)).toHaveTextContent('included');
    expect(screen.getByTestId(`inclusion-bundle-now-${SUSPENDED}`)).toBeDisabled();
    expect(screen.getByTestId(`inclusion-bundle-now-${ACTIVE}`)).toBeEnabled();
    // Not counted as in tonight's run.
    expect(screen.getByTestId('tenant-inclusion-summary').querySelector('summary'))
      .toHaveTextContent('Scheduled inclusion: 1/2 tenants in the daily backup cron (1 paused — suspended)');
  });

  it('"Bundle all eligible tenants" leaves it out', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('tenants-bundle-all')).toBeEnabled());
    fireEvent.click(screen.getByTestId('tenants-bundle-all'));
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => u === '/api/v1/admin/tenant-bundles' && i?.method === 'POST')).toBe(true));
    const bundled = apiFetch.mock.calls
      .filter(([u, i]) => u === '/api/v1/admin/tenant-bundles' && i?.method === 'POST')
      .map(([, i]) => (JSON.parse(i?.body ?? '{}') as { tenantId: string }).tenantId);
    expect(bundled).toEqual([ACTIVE]);
  });
});
