/**
 * Admin Tenant Backups — grouped by tenant.
 *
 * The flat cross-tenant table answered "what happened recently". An operator
 * opening this page is almost always asking "how is THIS tenant covered", which
 * meant scanning a mixed list. Each tenant is now one collapsible line that
 * opens onto its bundles, its sizes, and its restore carts.
 *
 * The size columns are the part worth pinning down. Two different numbers are
 * shown and must stay distinguishable:
 *   bundles — the logical sum of bundle sizes. restic deduplicates, so this is
 *             NOT the storage consumed.
 *   repo    — measured by `restic stats`; "not measured" until someone presses
 *             Refresh. It must never render as 0, which reads as "no backups".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const BUNDLES = [
  { id: 'b1', tenantId: TENANT_A, tenantName: 'Acme', status: 'completed', label: 'nightly', sizeBytes: 1_000_000, createdAt: '2026-08-29T00:00:00.000Z', initiator: 'system', lastError: null },
  { id: 'b2', tenantId: TENANT_A, tenantName: 'Acme', status: 'completed', label: 'manual', sizeBytes: 2_000_000, createdAt: '2026-08-30T00:00:00.000Z', initiator: 'tenant', lastError: null },
  { id: 'b3', tenantId: TENANT_B, tenantName: 'Beta', status: 'failed', label: null, sizeBytes: 0, createdAt: '2026-08-30T01:00:00.000Z', initiator: 'system', lastError: 'boom' },
];

const CARTS = [
  { id: 'cart-a-1', tenantId: TENANT_A, bundleId: 'b1', status: 'draft', description: 'partial', createdAt: '2026-08-29T10:00:00.000Z' },
  { id: 'cart-a-2', tenantId: TENANT_A, bundleId: 'b2', status: 'executing', description: 'running', createdAt: '2026-08-30T10:00:00.000Z' },
];

const ROLLUP = [
  { tenantId: TENANT_A, tenantName: 'Acme', bundleCount: 2, bundleBytes: 3_000_000, repoTotalBytes: 1_500_000, repoStatsAt: '2026-08-30T12:00:00.000Z', includedInScheduledBundles: true, scheduledBundlesOverride: 'inherit', snapshotCount: 0, snapshotBytes: 0, lastSnapshotAt: null, lastBundleAt: null, snapshotQuotaPct: null, openCartId: null, isSystem: false, planName: 'Ultimate' },
  { tenantId: TENANT_B, tenantName: 'Beta', bundleCount: 1, bundleBytes: 0, repoTotalBytes: null, repoStatsAt: null, includedInScheduledBundles: true, scheduledBundlesOverride: 'inherit', snapshotCount: 0, snapshotBytes: 0, lastSnapshotAt: null, lastBundleAt: null, snapshotQuotaPct: null, openCartId: null, isSystem: false, planName: 'Starter' },
];

const apiFetch = vi.fn(async (url: string, init?: { method?: string }) => {
  if (url.includes('/admin/restores/carts?')) return { data: { data: CARTS } };
  if (url.includes('/repo-stats/refresh')) return { data: { totalBytes: 4_242_000, measuredAt: '2026-08-30T13:00:00.000Z', components: [] } };
  if (url.includes('/admin/backups/tenants/overview')) return { data: { rows: ROLLUP, kpi: {}, generatedAt: '' } };
  if (url.includes('/admin/tenant-bundles')) return { data: BUNDLES };
  if (url.includes('/admin/backups/tenants/snapshots')) return { data: { rows: [] } };
  if (init?.method === 'DELETE') return undefined;
  return { data: [] };
});
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...(a as [string, { method?: string }?])) }));
vi.mock('@/hooks/use-backup-rclone-shim', () => ({ useShimAssignments: () => ({ data: { data: [] } }) }));

const Page = (await import('@/pages/backups/TenantsBackupsPage')).default;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Page /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('tenant backup grouping', () => {
  it('renders one collapsible group per tenant, collapsed by default', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    expect(screen.getByTestId(`tenant-backup-group-${TENANT_B}`)).toBeInTheDocument();
    // Collapsed: the per-bundle restore buttons are not mounted yet.
    expect(screen.queryByTestId('tenant-bundle-restore-b1')).toBeNull();
    expect(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`))
      .toHaveAttribute('aria-expanded', 'false');
  });

  it('shows that tenant’s backups when opened', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    // Acme's two bundles appear; Beta's does not.
    expect(screen.getByTestId('tenant-bundle-restore-b1')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-bundle-restore-b2')).toBeInTheDocument();
    expect(screen.queryByTestId('tenant-bundle-restore-b3')).toBeNull();
  });

  it('says "not measured" rather than 0 when the repo has never been measured', async () => {
    // 0 would read as "this tenant has no backups", which is a different and
    // wrong statement.
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-repo-size-${TENANT_B}`)).toBeInTheDocument());
    expect(screen.getByTestId(`tenant-repo-size-${TENANT_B}`).textContent).toContain('not measured');
  });

  it('shows the measured repo size when one exists', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-repo-size-${TENANT_A}`)).toBeInTheDocument());
    const text = screen.getByTestId(`tenant-repo-size-${TENANT_A}`).textContent ?? '';
    expect(text).not.toContain('not measured');
    expect(text).toContain('repo');
  });

  it('measures the repo through the refresh endpoint', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    fireEvent.click(screen.getByTestId(`tenant-repo-refresh-${TENANT_A}`));
    await waitFor(() => {
      expect(apiFetch.mock.calls.some(([u]) =>
        String(u).includes(`/admin/backups/tenants/${TENANT_A}/repo-stats/refresh`))).toBe(true);
    });
  });
});

describe('restore carts in the group', () => {
  it('lists the tenant’s carts', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    expect(screen.getByTestId('admin-cart-row-cart-a-1')).toBeInTheDocument();
    expect(screen.getByTestId('admin-cart-row-cart-a-2')).toBeInTheDocument();
  });

  it('resumes a cart by navigating with its cartId, not starting a new one', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    fireEvent.click(screen.getByTestId('admin-cart-resume-cart-a-1'));
    expect(navigate).toHaveBeenCalled();
    const url = String(navigate.mock.calls[0][0]);
    expect(url).toContain('cartId=cart-a-1');
    expect(url).toContain('bundleId=b1');
  });

  it('disables resume and delete for a cart that is executing', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    expect(screen.getByTestId('admin-cart-resume-cart-a-2')).toBeDisabled();
    expect(screen.getByTestId('admin-cart-delete-cart-a-2')).toBeDisabled();
  });

  it('deletes a cart through the admin endpoint', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    fireEvent.click(screen.getByTestId('admin-cart-delete-cart-a-1'));
    await waitFor(() => {
      expect(apiFetch.mock.calls.some(([u, i]) =>
        String(u).includes('/admin/restores/carts/cart-a-1') && i?.method === 'DELETE')).toBe(true);
    });
  });
});
