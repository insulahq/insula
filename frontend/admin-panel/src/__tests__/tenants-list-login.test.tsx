/**
 * "Login" button on the tenants list — the same impersonation action as the
 * tenant detail header, one click earlier.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const mockOpen = vi.fn();
const mockUseLoginAsTenant = vi.fn();

vi.mock('@/hooks/use-impersonate', () => ({
  useLoginAsTenant: (...a: unknown[]) => mockUseLoginAsTenant(...a),
  useImpersonate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const TENANTS = [
  { id: 't-1', name: 'Acme Ltd', primaryEmail: 'ops@example.test', status: 'active', isSystem: false },
  { id: 't-2', name: 'SYSTEM', primaryEmail: 'sys@example.test', status: 'active', isSystem: true },
];

vi.mock('@/hooks/use-tenants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-tenants')>()),
  useTenants: () => ({ data: { data: TENANTS, pagination: {} }, isLoading: false, error: null }),
}));

vi.mock('@/hooks/use-bulk-tenants', () => ({
  useBulkSuspendTenants: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBulkReactivateTenants: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBulkDeleteTenants: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-resource-metrics', () => ({
  useAllTenantMetrics: () => ({ data: undefined, isLoading: false }),
}));

// Heavy children that pull in their own hook trees — not under test here.
vi.mock('@/components/CreateTenantModal', () => ({ default: () => null }));
vi.mock('@/components/BulkProgressModal', () => ({ default: () => null }));
vi.mock('@/components/BulkResultModal', () => ({ default: () => null }));

const TenantsListTab = (await import('@/pages/tenants/TenantsListTab')).default;

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><TenantsListTab /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TenantsListTab — Login as tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockResolvedValue(true);
    mockUseLoginAsTenant.mockReturnValue({
      open: mockOpen, isPending: false, error: null, isUnconfigured: false,
    });
  });

  it('renders a Login button on each tenant row', () => {
    renderList();
    expect(screen.getByTestId('login-as-tenant-t-1')).toBeInTheDocument();
    expect(screen.getByTestId('login-as-tenant-t-2')).toBeInTheDocument();
  });

  it('starts the tenant session for the row that was clicked', async () => {
    renderList();
    fireEvent.click(screen.getByTestId('login-as-tenant-t-1'));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledWith('t-1'));
  });

  it('does not navigate to the detail page when the button is clicked', async () => {
    // The whole row is a click target; without stopPropagation the operator
    // would land on the detail page instead of the tenant panel.
    renderList();
    fireEvent.click(screen.getByTestId('login-as-tenant-t-1'));
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(screen.getByTestId('login-as-tenant-t-1')).toBeInTheDocument();
  });

  it('surfaces an OperatorError when no tenant panel URL is configured', async () => {
    mockOpen.mockResolvedValue(false);
    renderList();
    fireEvent.click(screen.getByTestId('login-as-tenant-t-1'));
    const panel = await screen.findByTestId('login-as-tenant-error');
    expect(panel.textContent).toContain('Tenant Panel URL is not configured');
  });

  it('surfaces an OperatorError when impersonation itself fails', async () => {
    mockOpen.mockRejectedValue(new Error('No active tenant_admin user found for this tenant'));
    renderList();
    fireEvent.click(screen.getByTestId('login-as-tenant-t-1'));
    const panel = await screen.findByTestId('login-as-tenant-error');
    expect(panel.textContent).toContain('Could not start a tenant session');
    expect(panel.textContent).toContain('tenant_admin');
  });
});
