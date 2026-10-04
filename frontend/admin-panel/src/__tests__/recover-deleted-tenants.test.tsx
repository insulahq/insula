/**
 * A deleted tenant keeps its off-site bundles for the deleted-tenant window —
 * so it can be recovered. But it has no row any more: it appeared in no tenant
 * list, and the recover picker (built from the newest 50 bundles across all
 * tenants) lost it within a night or two, and showed it unnamed when it did.
 * These pin that it is findable BY NAME everywhere an operator would look.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RecoverableTenant } from '@insula/api-contracts';

const fetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => fetchMock(...a) }));

const { default: DeletedTenantsCard } = await import('@/components/backups/DeletedTenantsCard');
const { default: TenantRecoverTab } = await import('@/components/system-backup/TenantRecoverTab');
const { default: TenantDeletedBanner } = await import('@/components/tenants/TenantDeletedBanner');

const GONE: RecoverableTenant = {
  tenantId: '11111111-2222-4333-8444-555555555555', name: 'ACME LEARNING', deleted: true,
  deletedAt: '2026-10-03T17:00:17.498Z', bundleCount: 14, newestBundleAt: '2026-10-03T01:36:57.662Z',
  newestCompletedBundleId: 'bkp-79a722d1', keptUntil: '2026-11-02T17:00:00.000Z',
};
const GONE_INFO = {
  tenantId: GONE.tenantId, name: 'ACME LEARNING', deleted: true, deletedAt: GONE.deletedAt,
  source: 'bundle', infoFromBundleId: 'bkp-79a722d1', infoError: null, status: 'active',
  planName: 'Business', storageTier: 'local', primaryNode: 'sv1',
  namespace: 'tenant-example-0a1b2c3d', namespacePresent: false, namespaceTerminating: false,
  resources: { cpuLimit: 2, memoryLimit: 4, storageLimit: 20 },
  bundles: [
    { id: 'bkp-79a722d1', createdAt: '2026-10-03T01:36:57.662Z', finishedAt: null, status: 'completed', trigger: 'scheduled', label: null,
      sizeBytes: 1_288_490_188, components: [{ component: 'files', sizeBytes: 1_288_490_188 }], expiresAt: '2026-11-02T17:00:00.000Z' },
    { id: 'bkp-60a84d06', createdAt: '2026-10-02T01:35:56.197Z', finishedAt: null, status: 'completed', trigger: 'scheduled', label: null,
      sizeBytes: 1_200_000_000, components: [{ component: 'files', sizeBytes: 1_200_000_000 }], expiresAt: '2026-11-02T17:00:00.000Z' },
    { id: 'bkp-612ce295', createdAt: '2026-09-27T01:30:00.000Z', finishedAt: null, status: 'partial', trigger: 'scheduled', label: null,
      sizeBytes: 0, components: [], expiresAt: '2026-11-02T17:00:00.000Z' },
  ],
};
const ACME: RecoverableTenant = {
  tenantId: 'acme-1', name: 'Acme', deleted: false, deletedAt: null, bundleCount: 26,
  newestBundleAt: '2026-10-03T01:30:00.000Z', newestCompletedBundleId: 'bkp-acme', keptUntil: null,
};

function api(recoverable: RecoverableTenant[]) {
  fetchMock.mockImplementation(async (raw: unknown) => {
    const url = typeof raw === 'string' ? raw : '';
    if (url === '/api/v1/admin/tenant-bundles/recoverable-tenants') return { data: recoverable };
    if (url.startsWith(`/api/v1/admin/dr/tenants/${GONE.tenantId}/recovery-info`)) return { data: GONE_INFO };
    if (url === '/api/v1/admin/nodes') {
      return { data: [{ name: 'sv1', role: 'server', canHostTenantWorkloads: true, statusConditions: [{ type: 'Ready', status: 'True' }] }] };
    }
    if (url.startsWith('/api/v1/admin/tenant-bundles?tenantId=')) {
      return { data: [
        { id: 'bkp-79a722d1', status: 'completed', createdAt: '2026-10-03T01:36:57.662Z', sizeBytes: 1500, expiresAt: '2026-11-02T17:00:00.000Z' },
        { id: 'bkp-older', status: 'completed', createdAt: '2026-10-02T01:35:56.197Z', sizeBytes: 1500, expiresAt: '2026-11-02T17:00:00.000Z' },
      ] };
    }
    return { data: [] };
  });
}

function renderAt(path: string, element: React.ReactNode, state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[state ? { pathname: path.split('?')[0], search: path.includes('?') ? `?${path.split('?')[1]}` : '', state } : path]}>
        <Routes><Route path="*" element={element} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => fetchMock.mockReset());

describe('Backups → Tenants: deleted tenants card', () => {
  it('lists each deleted tenant by name, with how long it stays recoverable and a Recover link', async () => {
    api([GONE, ACME]);
    renderAt('/backups/tenants', <DeletedTenantsCard />);
    const row = await screen.findByTestId(`deleted-tenant-${GONE.tenantId}`);
    expect(row).toHaveTextContent('ACME LEARNING');
    expect(row).toHaveTextContent('2026-10-03');
    expect(row).toHaveTextContent('2026-11-02');
    expect(screen.getByTestId(`recover-deleted-${GONE.tenantId}`))
      .toHaveAttribute('href', `/backups/disaster-recovery?section=recover&tenant=${GONE.tenantId}`);
    // Live tenants are not "deleted tenants".
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
  });

  it('renders nothing when no deleted tenant is recoverable', async () => {
    api([ACME]);
    const { container } = renderAt('/backups/tenants', <DeletedTenantsCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DR → Recover Tenant', () => {
  it('opens on the deleted tenant from the link — named, with what it was and its bundles by date and size', async () => {
    api([GONE, ACME]);
    renderAt(`/backups/disaster-recovery?section=recover&tenant=${GONE.tenantId}`, <TenantRecoverTab />);
    const picker = await screen.findByTestId('dr-recover-tenant-picker');
    await waitFor(() => expect(picker).toHaveTextContent('ACME LEARNING'));
    const facts = await screen.findByTestId('dr-recover-facts');
    expect(facts).toHaveTextContent('deleted 2026-10-03');
    expect(facts).toHaveTextContent('Business');
    expect(facts).toHaveTextContent('tenant-example-0a1b2c3d');
    expect(facts).toHaveTextContent('missing');
    const bundles = screen.getByTestId('dr-recover-bundles');
    expect(bundles).toHaveTextContent('2026-10-03 01:36 UTC');
    expect(bundles).toHaveTextContent('1.2 GB');
    // The newest completed bundle is the default; an older one is a click away — no ids.
    const newest = screen.getByTestId('dr-bundle-bkp-79a722d1').querySelector('input') as HTMLInputElement;
    const older = screen.getByTestId('dr-bundle-bkp-60a84d06').querySelector('input') as HTMLInputElement;
    expect(newest.checked).toBe(true);
    fireEvent.click(screen.getByTestId('dr-bundle-bkp-60a84d06'));
    await waitFor(() => expect(older.checked).toBe(true));
    // A partial bundle is listed but cannot be chosen.
    expect((screen.getByTestId('dr-bundle-bkp-612ce295').querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });

  it('finds a tenant by typing', async () => {
    api([GONE, ACME]);
    renderAt('/backups/disaster-recovery?section=recover', <TenantRecoverTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Search tenants|Tenant/ }));
    fireEvent.change(await screen.findByPlaceholderText('Search tenants…'), { target: { value: 'learning' } });
    const options = await within(await screen.findByRole('listbox')).findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('ACME LEARNING')]);
  });
});

describe('the "Tenant was deleted" banner', () => {
  it('says the tenant can still be recovered, until when, and links there', async () => {
    api([GONE]);
    renderAt('/tenants/list', <TenantDeletedBanner />, { deletedTenant: { name: 'ACME LEARNING', id: GONE.tenantId } });
    const line = await screen.findByTestId('tenant-deleted-recoverable');
    expect(line).toHaveTextContent('kept until 2026-11-02');
    expect(screen.getByRole('link', { name: 'Recover…' }))
      .toHaveAttribute('href', `/backups/disaster-recovery?section=recover&tenant=${GONE.tenantId}`);
  });

  it('says plainly when there is nothing to recover from', async () => {
    api([]);
    renderAt('/tenants/list', <TenantDeletedBanner />, { deletedTenant: { name: 'Throwaway', id: 'never-backed-up' } });
    expect(await screen.findByTestId('tenant-deleted-unrecoverable')).toHaveTextContent('cannot be recovered');
  });
});
