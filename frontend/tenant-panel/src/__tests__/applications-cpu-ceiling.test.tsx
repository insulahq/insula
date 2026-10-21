import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Applications from '../pages/Applications';

// Under the tier model a deployment's cpuRequest is the tenant's share under
// contention, so "8m / 100m" read as an app at 8% of its room when it could
// burst to six cores. The list and the grid card measure CPU against the
// plan's burst ceiling instead.

const _mockAuthState = {
  user: { id: 'tenant-1', email: 'test@example.com', fullName: 'Test User', role: 'tenant_admin' },
  token: 'test-token', isAuthenticated: true, isLoading: false, error: null,
  login: vi.fn(), logout: vi.fn(), initialize: vi.fn(),
};
vi.mock('../hooks/use-auth', () => ({
  useAuth: <T,>(selector?: (state: typeof _mockAuthState) => T) =>
    (selector ? selector(_mockAuthState) : _mockAuthState),
}));
vi.mock('../hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'tenant-1', tenantName: 'Test Company', isLoading: false })),
}));

const DEPLOYMENTS = [
  { id: 'd1', name: 'blog-prod', status: 'running', catalogEntryId: 'c-wp', source: 'catalog', updatedAt: new Date().toISOString(), cpuRequest: '100m', memoryRequest: '512Mi' },
];

let cpuModel: { cpuModel: 'legacy' | 'tiered'; cpuBurstCores: number | null } = { cpuModel: 'tiered', cpuBurstCores: 6 };
vi.mock('../hooks/use-resource-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/use-resource-availability')>()),
  useResourceAvailability: vi.fn(() => ({ data: { data: cpuModel }, isLoading: false })),
}));

const CATALOG = [
  { id: 'c-wp', name: 'WordPress', type: 'application', category: 'cms' },
  { id: 'c-pg', name: 'PostgreSQL', type: 'database', category: 'data' },
];

vi.mock('../hooks/use-deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-deployments')>();
  return {
    ...actual,
    useDeployments: vi.fn(() => ({ data: { data: DEPLOYMENTS }, isLoading: false })),
    useCreateDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
    useUpdateDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, mutate: vi.fn(), reset: vi.fn(), isError: false, error: null })),
    useUpdateDeploymentResources: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() })),
    useDeleteDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
    useRestartDeployment: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useRestoreDeployment: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    usePermanentDeleteDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
    useResourceAvailability: vi.fn(() => ({ data: undefined, isLoading: false })),
    useDeploymentLogs: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
    useDeploymentLiveMetrics: vi.fn(() => ({ data: { data: { cpuUsed: 0.008, memoryUsedMi: 100, storageUsedBytes: 0 } }, isLoading: false })),
    useDeletePreview: vi.fn(() => ({ data: undefined, isLoading: false })),
    useStorageFolders: vi.fn(() => ({ data: undefined, isLoading: false })),
  };
});

vi.mock('../hooks/use-catalog', () => ({
  useCatalog: vi.fn(() => ({ data: { data: CATALOG }, isLoading: false, isError: false, error: null })),
  useCatalogEntryVersions: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
}));

function renderApps() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Applications /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Installed tab — CPU against the burst ceiling', () => {
  beforeEach(() => {
    localStorage.clear();
    cpuModel = { cpuModel: 'tiered', cpuBurstCores: 6 };
  });

  it('the list shows used / burst ceiling, not used / request', () => {
    renderApps();
    fireEvent.click(screen.getByTestId('view-mode-list'));
    const cell = screen.getByTestId('usage-cpu-d1');
    expect(cell).toHaveTextContent('8m / 6 cores');
    expect(cell).not.toHaveTextContent('100m');
  });

  it('the grid card does the same', () => {
    renderApps();
    const card = screen.getByTestId('grid-cpu-d1');
    expect(card).toHaveTextContent('8m / 6 cores');
    expect(card).not.toHaveTextContent('100m');
  });

  it('a legacy tenant keeps used / request — its request is a size it chose', () => {
    cpuModel = { cpuModel: 'legacy', cpuBurstCores: null };
    renderApps();
    fireEvent.click(screen.getByTestId('view-mode-list'));
    expect(screen.getByTestId('usage-cpu-d1')).toHaveTextContent('8m / 100m');
  });
});
