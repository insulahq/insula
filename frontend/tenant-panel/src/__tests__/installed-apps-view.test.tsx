import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Applications from '../pages/Applications';

// The Installed tab listed every deployment as a card with no way to find one
// by name — fine for three apps, unusable for thirty. It now has the search box
// and the grid/list switch the admin panel's Installed tab already had.

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
  { id: 'd1', name: 'blog-prod', status: 'running', catalogEntryId: 'c-wp', source: 'catalog', updatedAt: new Date().toISOString(), cpuRequest: '500m', memoryRequest: '512Mi' },
  { id: 'd2', name: 'shop-staging', status: 'stopped', catalogEntryId: 'c-wp', source: 'catalog', updatedAt: new Date().toISOString(), cpuRequest: '500m', memoryRequest: '512Mi' },
  { id: 'd3', name: 'analytics-db', status: 'failed', catalogEntryId: 'c-pg', source: 'catalog', updatedAt: new Date().toISOString(), cpuRequest: '500m', memoryRequest: '512Mi' },
];

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
    useUpdateDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, mutate: vi.fn() })),
    useUpdateDeploymentResources: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isError: false, error: null })),
    useDeleteDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
    useRestartDeployment: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useRestoreDeployment: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    usePermanentDeleteDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
    useResourceAvailability: vi.fn(() => ({ data: undefined, isLoading: false })),
    useDeploymentLogs: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
    useDeploymentLiveMetrics: vi.fn(() => ({ data: undefined, isLoading: false })),
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

const search = () => screen.getByTestId('installed-search');

describe('Installed tab — search', () => {
  beforeEach(() => localStorage.clear());

  it('shows the toolbar with a total count', () => {
    renderApps();
    expect(screen.getByTestId('installed-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('installed-count')).toHaveTextContent('3 deployments');
  });

  it('filters by deployment name', () => {
    renderApps();
    fireEvent.change(search(), { target: { value: 'blog' } });
    expect(screen.getByText('blog-prod')).toBeInTheDocument();
    expect(screen.queryByText('shop-staging')).not.toBeInTheDocument();
    expect(screen.getByTestId('installed-count')).toHaveTextContent('1 of 3');
  });

  it('filters by the application it came from, not just the instance name', () => {
    // "wordpress" appears in no deployment NAME — only in the catalog entry.
    renderApps();
    fireEvent.change(search(), { target: { value: 'wordpress' } });
    expect(screen.getByText('blog-prod')).toBeInTheDocument();
    expect(screen.getByText('shop-staging')).toBeInTheDocument();
    expect(screen.queryByText('analytics-db')).not.toBeInTheDocument();
  });

  it('filters by status, so "the failed one" is findable', () => {
    renderApps();
    fireEvent.change(search(), { target: { value: 'failed' } });
    expect(screen.getByText('analytics-db')).toBeInTheDocument();
    expect(screen.queryByText('blog-prod')).not.toBeInTheDocument();
  });

  it('is case-insensitive', () => {
    renderApps();
    fireEvent.change(search(), { target: { value: 'BLOG' } });
    expect(screen.getByText('blog-prod')).toBeInTheDocument();
  });

  it('says so when nothing matches rather than rendering a blank page', () => {
    renderApps();
    fireEvent.change(search(), { target: { value: 'nothing-matches-this' } });
    expect(screen.getByTestId('installed-no-matches')).toBeInTheDocument();
    // NOT the "no applications installed yet" empty state — the tenant has
    // three; they just filtered them all out.
    expect(screen.queryByTestId('installed-empty')).not.toBeInTheDocument();
  });
});

describe('Installed tab — grid/list view', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to grid, with no table rendered', () => {
    renderApps();
    expect(screen.getByTestId('view-mode-grid')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('view-mode-list')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('installed-list')).not.toBeInTheDocument();
  });

  it('switches to a table listing every deployment', () => {
    renderApps();
    fireEvent.click(screen.getByTestId('view-mode-list'));

    const table = screen.getByTestId('installed-list');
    expect(table).toBeInTheDocument();
    for (const d of DEPLOYMENTS) {
      expect(screen.getByTestId(`installed-row-${d.id}`)).toBeInTheDocument();
    }
    // The application name resolves through the catalog, not the raw id.
    expect(within(table).getAllByText('WordPress')).toHaveLength(2);
    expect(within(table).getByText('PostgreSQL')).toBeInTheDocument();
  });

  it('keeps the same actions available on a row', () => {
    renderApps();
    fireEvent.click(screen.getByTestId('view-mode-list'));

    expect(screen.getByTestId('row-toggle-d1')).toHaveTextContent('Stop');   // running
    expect(screen.getByTestId('row-toggle-d2')).toHaveTextContent('Start');  // stopped
    expect(screen.getByTestId('row-details-d1')).toBeInTheDocument();
    expect(screen.getByTestId('row-delete-d1')).toBeInTheDocument();
    // Preview only makes sense for a running app.
    expect(screen.getByTestId('row-preview-d1')).toBeInTheDocument();
    expect(screen.queryByTestId('row-preview-d2')).not.toBeInTheDocument();
  });

  it('search and view mode compose', () => {
    renderApps();
    fireEvent.click(screen.getByTestId('view-mode-list'));
    fireEvent.change(search(), { target: { value: 'analytics' } });

    expect(screen.getByTestId('installed-row-d3')).toBeInTheDocument();
    expect(screen.queryByTestId('installed-row-d1')).not.toBeInTheDocument();
  });

  it('remembers the choice across visits', () => {
    const first = renderApps();
    fireEvent.click(screen.getByTestId('view-mode-list'));
    expect(localStorage.getItem('tenant.applications.viewMode')).toBe('list');
    first.unmount();

    // A tenant who picked the dense list should not have to re-pick it.
    renderApps();
    expect(screen.getByTestId('view-mode-list')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('installed-list')).toBeInTheDocument();
  });
});
