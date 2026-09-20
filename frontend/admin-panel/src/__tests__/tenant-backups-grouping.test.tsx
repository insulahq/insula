/**
 * Admin Tenant Backups — grouped by tenant.
 *
 * The flat cross-tenant table answered "what happened recently". An operator
 * opening this page is almost always asking "how is THIS tenant covered", which
 * meant scanning a mixed list. Each tenant is now one collapsible line that
 * opens onto its bundles, its sizes, and its restore carts.
 *
 * The size story is the part worth pinning down. The logical "bundles <sum>"
 * figure is GONE from the group header: on a tenant holding 15 GB it read
 * 452 GB, because every nightly bundle re-states the whole footprint, and
 * operators read it as their off-site storage filling up. What remains is:
 *   repo         — what the target actually holds. "not measured yet" until
 *                  something measures it; never 0, which reads as "no backups".
 *   Bundle Size  — per bundle, the logical size (do not add these up).
 *   Restic Size  — per bundle, what it ADDED. These DO add up.
 *
 * And the loading shape: the page fetches ONLY the rollup up front — every
 * tenant's name, backup count and repository size. No bundle is fetched until
 * a group is opened; opening one then loads that tenant's COMPLETE history,
 * following the cursor to the end on the operator's behalf.
 *
 * The fixtures below make the rollup and the bundle pages deliberately
 * DISAGREE (26 in the rollup, 3 + 1 across two pages) so that a regression to
 * counting fetched rows fails instead of passing on a fixture that happens to
 * match.
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

// Page 1 of a list that has more. `resticAddedBytes` is null on b2 on
// purpose: bundles captured before the column existed have no figure, and
// that has to render as "unknown", not as 0.
const BUNDLES_PAGE_1 = [
  { id: 'b1', tenantId: TENANT_A, tenantName: 'Acme', status: 'completed', label: 'nightly', sizeBytes: 1_000_000, resticAddedBytes: 4_096, createdAt: '2026-08-29T00:00:00.000Z', initiator: 'system', lastError: null },
  { id: 'b2', tenantId: TENANT_A, tenantName: 'Acme', status: 'completed', label: 'manual', sizeBytes: 2_000_000, resticAddedBytes: null, createdAt: '2026-08-30T00:00:00.000Z', initiator: 'tenant', lastError: null },
];
const BUNDLES_PAGE_2 = [
  { id: 'b4', tenantId: TENANT_A, tenantName: 'Acme', status: 'completed', label: 'older', sizeBytes: 1_500_000, resticAddedBytes: 2_048, createdAt: '2026-08-28T00:00:00.000Z', initiator: 'system', lastError: null },
];
/** Total across ALL pages, as the server reports it in the envelope. */
const BUNDLE_TOTAL = 27;

const CARTS = [
  { id: 'cart-a-1', tenantId: TENANT_A, bundleId: 'b1', status: 'draft', description: 'partial', createdAt: '2026-08-29T10:00:00.000Z' },
  { id: 'cart-a-2', tenantId: TENANT_A, bundleId: 'b2', status: 'executing', description: 'running', createdAt: '2026-08-30T10:00:00.000Z' },
];

// Acme holds 26 bundles; only 2 of them are on page 1. The disagreement is
// the point — see the file header.
const ROLLUP = [
  { tenantId: TENANT_A, tenantName: 'Acme', bundleCount: 26, bundleBytes: 452_000_000, repoTotalBytes: 1_500_000, repoStatsAt: '2026-08-30T12:00:00.000Z', repoVerifiedAt: '2026-08-30T12:00:00.000Z', repoTotalSource: 'tracked', includedInScheduledBundles: true, scheduledBundlesOverride: 'inherit', snapshotCount: 0, snapshotBytes: 0, lastSnapshotAt: null, lastBundleAt: null, snapshotQuotaPct: null, openCartId: null, isSystem: false, planName: 'Ultimate' },
  { tenantId: TENANT_B, tenantName: 'Beta', bundleCount: 1, bundleBytes: 0, repoTotalBytes: null, repoStatsAt: null, repoVerifiedAt: null, repoTotalSource: null, includedInScheduledBundles: true, scheduledBundlesOverride: 'inherit', snapshotCount: 0, snapshotBytes: 0, lastSnapshotAt: null, lastBundleAt: null, snapshotQuotaPct: null, openCartId: null, isSystem: false, planName: 'Starter' },
];

const apiFetch = vi.fn(async (url: string, init?: { method?: string }) => {
  if (url.includes('/admin/restores/carts?')) return { data: { data: CARTS } };
  if (url.includes('/repo-stats/refresh')) return { data: { totalBytes: 4_242_000, measuredAt: '2026-08-30T13:00:00.000Z', components: [] } };
  if (url.includes('/admin/backups/tenants/overview')) return { data: { rows: ROLLUP, kpi: {}, generatedAt: '' } };
  if (url.includes('/admin/tenant-bundles')) {
    // Behave like the real endpoint: scoped to one tenant, and a cursor
    // returns the NEXT page. A mock that ignored either would let a client
    // that never sends them still look correct.
    const tenant = /tenantId=([^&]+)/.exec(url)?.[1];
    if (tenant !== TENANT_A) {
      return { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 100 } };
    }
    const hasCursor = url.includes('cursor=');
    return hasCursor
      ? { data: BUNDLES_PAGE_2, pagination: { total_count: BUNDLE_TOTAL, cursor: null, has_more: false, page_size: 100 } }
      : { data: BUNDLES_PAGE_1, pagination: { total_count: BUNDLE_TOTAL, cursor: 'b2', has_more: true, page_size: 100 } };
  }
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

  it('fetches NO bundles until a group is opened', async () => {
    // The page used to pull a page of bundles across all tenants on mount.
    // Its only up-front request is now the rollup.
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes('/admin/tenant-bundles?'))).toBe(false);
  });

  it('loads that tenant’s backups when opened, and only that tenant’s', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    await waitFor(() => expect(screen.getByTestId('tenant-bundle-restore-b1')).toBeInTheDocument());
    // Every bundle request is scoped to the tenant whose group was opened.
    const bundleCalls = apiFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/admin/tenant-bundles?'));
    expect(bundleCalls.length).toBeGreaterThan(0);
    expect(bundleCalls.every((u) => u.includes(`tenantId=${TENANT_A}`))).toBe(true);
  });

  it('follows the cursor to the END without the operator asking', async () => {
    // b4 is on page 2. Nothing is clicked between opening the group and it
    // appearing — the old shape needed a "Load more" press per page.
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    await waitFor(() => expect(screen.getByTestId('tenant-bundle-restore-b4')).toBeInTheDocument());
    expect(screen.getByTestId('tenant-bundle-restore-b1')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-bundle-restore-b2')).toBeInTheDocument();
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes('cursor=b2'))).toBe(true);
  });

  it('shows a loader naming the count it is fetching', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    // The rollup already knows the total, so the wait states the size of the
    // job rather than spinning anonymously.
    const loader = await screen.findByTestId(`tenant-bundle-loading-${TENANT_A}`);
    expect(loader.textContent).toContain('26');
  });

  it('lists a tenant that has no bundles at all', async () => {
    // Groups come from the rollup. Deriving them from fetched rows meant a
    // tenant with nothing in the fetched page simply vanished from a page
    // whose job is saying who is covered.
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_B}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_B}`));
    await waitFor(() => expect(screen.getByTestId(`tenant-bundle-empty-${TENANT_B}`)).toBeInTheDocument());
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

  it('counts a tenant’s backups from the rollup, not from the page it fetched', async () => {
    // THE bug this file exists to prevent. The list is paged; Acme has 26
    // bundles and page 1 carries 2 of them. Reading the count off the fetched
    // rows reported "2 backups" for a tenant holding 26, across every tenant
    // at once, and read as a backup failure rather than a page size.
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    const header = screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`).textContent ?? '';
    expect(header).toContain('26 backups');
    expect(header).not.toContain('2 backups');
  });

  it('no longer shows a truncation line or a Load more button', async () => {
    // Both existed to cope with a cross-tenant page. Nothing is truncated now:
    // a group either has not been opened, or holds its tenant's whole history.
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    await waitFor(() => expect(screen.getByTestId('tenant-bundle-restore-b4')).toBeInTheDocument());
    expect(screen.queryByTestId('tenant-bundle-list-range')).toBeNull();
    expect(screen.queryByTestId('tenant-bundle-load-more')).toBeNull();
  });

  it('no longer shows the per-tenant filter chips', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    expect(screen.queryByTestId('tenant-bundle-counts')).toBeNull();
  });

  it('drops the logical "bundles <sum>" figure from the group header', async () => {
    // 452 GB of "bundles" next to a 1.5 MB repo was the whole complaint.
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    const header = screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`).textContent ?? '';
    expect(header).not.toContain('bundles ');
    expect(header).toContain('repo');
  });

  it('shows Bundle Size and Restic Size per bundle, with unknown as — not 0 B', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`tenant-backup-group-${TENANT_A}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`tenant-backup-group-toggle-${TENANT_A}`));
    await waitFor(() => expect(screen.getAllByText('Bundle Size').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Restic Size').length).toBeGreaterThan(0);
    // b1 reported 4096 bytes added; b2 reported nothing at all. Rendering the
    // second as "0 B" would claim the bundle added nothing, which is a
    // different statement from "we do not know".
    const row = screen.getByTestId('tenant-bundle-restore-b2').closest('tr');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('—');
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
