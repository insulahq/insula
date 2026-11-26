import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ApplicationsList from '@/components/tenant-detail/ApplicationsList';
import type { Deployment } from '@/hooks/use-deployments';
import { useAuth } from '@/hooks/use-auth';
import { apiFetch, ApiError } from '@/lib/api-client';

// "Repair database access" on a tenant's database instance: the place the
// admin notification "Platform lost its login to a tenant database" sends the
// operator. It redeploys the instance with a reset (the database restarts
// once), so it must ask first, say so, and show why it failed when it does.

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));
vi.mock('@/components/tenant-detail/TenantPanelLink', () => ({
  default: ({ children }: { readonly children: React.ReactNode }) => <span>{children}</span>,
}));

const mockApiFetch = vi.mocked(apiFetch);

const row = (over: Partial<Deployment> & Pick<Deployment, 'id' | 'name'>): Deployment => ({
  tenantId: 'tenant-001', catalogEntryId: 'c1', source: 'catalog', type: 'application', status: 'running',
  lastError: null, statusMessage: null, currentNodeName: null, replicaCount: 1, cpuRequest: '100m', memoryRequest: '256Mi',
  installedVersion: null, targetVersion: null, domainName: null, storagePath: null,
  createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
  ...over,
} as Deployment);

const DEPLOYMENTS: readonly Deployment[] = [
  row({ id: 'db1', name: 'shop-db', catalogEntryId: 'c-mariadb' }),
  row({ id: 'w1', name: 'web-app', catalogEntryId: 'c-node' }),
  row({ id: 'db2', name: 'old-db', catalogEntryId: 'c-mariadb', status: 'stopped' }),
  row({ id: 'db3', name: 'healthy-db', catalogEntryId: 'c-mariadb' }),
];

// The tenant's own deployment rows carry no catalog type; the admin list joins it.
const ADMIN_LIST = {
  data: [
    { id: 'db1', catalogEntryType: 'database', databaseAccessMode: 'locked' },
    { id: 'w1', catalogEntryType: 'runtime', databaseAccessMode: null },
    { id: 'db2', catalogEntryType: 'database', databaseAccessMode: 'locked' },
    { id: 'db3', catalogEntryType: 'database', databaseAccessMode: 'socket' },
  ],
  pagination: { page: 1, page_size: 4, total_count: 4, total_pages: 1, has_more: false },
};

const REPAIR_PATH = '/api/v1/admin/deployments/db1/repair-database-access';

type Answer = (path: string, init?: { method?: string }) => Promise<unknown>;

function answer(onRepair: Answer = () => Promise.resolve({ data: { redeployed: true } })): void {
  mockApiFetch.mockImplementation(((path: string, init?: { method?: string }) => {
    if (init?.method === 'POST' && path === REPAIR_PATH) return onRepair(path, init);
    if (path.startsWith('/api/v1/admin/deployments?')) return Promise.resolve(ADMIN_LIST);
    return Promise.resolve({ data: [] });
  }) as never);
}

function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ApplicationsList tenantId="tenant-001" deployments={DEPLOYMENTS} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const repairCalls = () => mockApiFetch.mock.calls.filter(([path, init]) => path === REPAIR_PATH && (init as { method?: string } | undefined)?.method === 'POST');

function signIn(role: string): void {
  useAuth.setState({ user: { id: 'u1', email: 'ops@example.test', fullName: 'Ops', role } });
}

describe('Repair database access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    answer();
    signIn('super_admin');
  });
  afterEach(() => {
    useAuth.setState({ user: null });
  });

  it('is offered on a running database instance whose login the platform lost, only', async () => {
    renderList();
    expect(await screen.findByTestId('repair-db-access-db1')).toHaveTextContent('Repair database access');
    expect(screen.queryByTestId('repair-db-access-w1')).not.toBeInTheDocument();
    // The platform still logs in: nothing to repair (the API would refuse it).
    expect(screen.queryByTestId('repair-db-access-db3')).not.toBeInTheDocument();
    // A stopped instance is never checked, so it cannot be the one that lost its login.
    expect(screen.queryByTestId('repair-db-access-db2')).not.toBeInTheDocument();
    // The type column says what the catalog says (the tenant rows carry none).
    expect(screen.getByTestId('application-db1')).toHaveTextContent('database');
  });

  it('is not offered to a role the endpoint refuses', async () => {
    signIn('support');
    renderList();
    await screen.findByTestId('application-db1');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('repair-db-access-db1')).not.toBeInTheDocument();
  });

  it('asks first, says the database restarts once and why one would use it; cancel sends nothing', async () => {
    renderList();
    fireEvent.click(await screen.findByTestId('repair-db-access-db1'));

    const dialog = screen.getByTestId('repair-db-access-dialog');
    expect(dialog).toHaveTextContent('shop-db');
    expect(dialog).toHaveTextContent('Platform lost its login to a tenant database');
    expect(dialog).toHaveTextContent(/SQL Manager, logical backups and restores/);
    expect(screen.getByTestId('repair-db-access-restart-warning')).toHaveTextContent('The database restarts once');
    expect(repairCalls()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('repair-db-access-cancel'));
    expect(screen.queryByTestId('repair-db-access-dialog')).not.toBeInTheDocument();
    expect(repairCalls()).toHaveLength(0);
  });

  it('opens with focus on Cancel and closes on Escape without sending anything', async () => {
    renderList();
    fireEvent.click(await screen.findByTestId('repair-db-access-db1'));
    expect(screen.getByTestId('repair-db-access-cancel')).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Repair database access' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('repair-db-access-dialog')).not.toBeInTheDocument();
    expect(repairCalls()).toHaveLength(0);
  });

  it('POSTs once on confirm, shows a spinner while it runs, then closes and says it started', async () => {
    let resolve!: (v: unknown) => void;
    answer(() => new Promise((r) => { resolve = r; }));
    renderList();
    fireEvent.click(await screen.findByTestId('repair-db-access-db1'));
    fireEvent.click(screen.getByTestId('repair-db-access-confirm'));

    await waitFor(() => expect(screen.getByTestId('repair-db-access-confirm')).toBeDisabled());
    expect(screen.getByTestId('repair-db-access-confirm').querySelector('.animate-spin')).not.toBeNull();
    expect(screen.getByTestId('repair-db-access-cancel')).toBeDisabled();
    expect(repairCalls()).toHaveLength(1);
    expect(repairCalls()[0]![1]).toEqual({ method: 'POST' });

    resolve({ data: { redeployed: true } });

    await waitFor(() => expect(screen.queryByTestId('repair-db-access-dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('repair-db-access-started-db1')).toHaveTextContent('the database restarts once');
  });

  it('shows why it failed in an error panel and keeps the dialog open', async () => {
    answer(() => Promise.reject(new ApiError(503, 'K8S_UNAVAILABLE', 'Kubernetes cluster is not available')));
    renderList();
    fireEvent.click(await screen.findByTestId('repair-db-access-db1'));
    fireEvent.click(screen.getByTestId('repair-db-access-confirm'));

    const panel = await screen.findByTestId('repair-db-access-error');
    expect(panel).toHaveTextContent('Kubernetes cluster is not available');
    expect(screen.getByTestId('repair-db-access-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('repair-db-access-started-db1')).not.toBeInTheDocument();
    expect(screen.getByTestId('repair-db-access-confirm')).not.toBeDisabled();
  });
});
