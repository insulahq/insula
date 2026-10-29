import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApplicationUsage } from '@insula/api-contracts';

// The subscription's application limit on the Applications page, and the
// Private Workers tab after Custom Containers. Hooks are mocked at their
// boundary; the page and the pill are real.
let usage: ApplicationUsage | undefined;
let workersListed = false;
let workersSettled = true;
let allowCustom = true;

const authState = {
  user: { id: 'u1', email: 'test@example.com', fullName: 'Test User', role: 'tenant_admin' },
  token: 't', isAuthenticated: true, isLoading: false, error: null,
  login: vi.fn(), logout: vi.fn(), initialize: vi.fn(),
};
vi.mock('../hooks/use-auth', () => ({
  useAuth: <T,>(selector?: (s: typeof authState) => T) => (selector ? selector(authState) : authState),
}));
vi.mock('../hooks/use-tenant-context', () => ({
  useTenantContext: () => ({ tenantId: 'tenant-1', tenantName: 'Test Company', isLoading: false }),
}));
vi.mock('../hooks/use-subscription', () => ({
  useSubscription: () => ({ data: { data: { allowCustomContainers: allowCustom } }, isError: false }),
}));
vi.mock('../hooks/use-application-usage', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-application-usage')>()),
  useApplicationUsage: () => ({ data: usage }),
}));
vi.mock('../hooks/use-private-workers-access', () => ({
  usePrivateWorkersAccess: () => ({ known: workersSettled, canCreate: workersListed, listed: workersListed, settled: workersSettled }),
}));
vi.mock('../pages/PrivateWorkers', () => ({
  default: ({ embedded, atLimit }: { embedded?: boolean; atLimit?: boolean }) => (
    <div data-testid="private-workers-tab-body" data-at-limit={String(atLimit)}>{String(embedded)}</div>
  ),
}));
vi.mock('../hooks/use-deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/use-deployments')>()),
  useDeployments: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, mutate: vi.fn(), reset: vi.fn(), isError: false, error: null })),
  useDeleteDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useRestartDeployment: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useRestoreDeployment: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
  usePermanentDeleteDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeploymentLiveMetrics: vi.fn(() => ({ data: undefined, isLoading: false })),
  useDeletePreview: vi.fn(() => ({ data: undefined, isLoading: false })),
}));
vi.mock('../hooks/use-catalog', () => ({
  useCatalog: vi.fn(() => ({ data: { data: [] }, isLoading: false, isError: false, error: null })),
  useCatalogEntryVersions: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
}));

const { default: Applications } = await import('../pages/Applications');

function renderAt(path = '/applications') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><Applications /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usage = { limit: 5, current: 3, privateWorkers: 0, remaining: 2, source: 'plan' };
  workersListed = false;
  workersSettled = true;
  allowCustom = true;
});

describe('Applications page — the subscription\'s application limit', () => {
  it('shows how many of the allowed applications are deployed', () => {
    renderAt();
    expect(screen.getByTestId('applications-usage')).toHaveTextContent('3 / 5 applications deployed');
    expect(screen.getByTestId('deploy-button')).toBeEnabled();
    expect(screen.queryByTestId('applications-limit-notice')).toBeNull();
  });

  it('★ at the limit: Deploy is disabled and the page says what to do', () => {
    usage = { limit: 2, current: 2, privateWorkers: 0, remaining: 0, source: 'plan' };
    renderAt();
    expect(screen.getByTestId('deploy-button')).toBeDisabled();
    expect(screen.getByTestId('applications-limit-notice')).toHaveTextContent(
      'You have deployed 2 of the 2 applications your subscription allows. Stopped applications and private workers count too.',
    );
  });

  it('★ private workers are in the count, and the pill says how many of it they are', () => {
    usage = { limit: 5, current: 3, privateWorkers: 1, remaining: 2, source: 'plan' };
    renderAt();
    const pill = screen.getByTestId('applications-usage');
    expect(pill).toHaveTextContent('3 / 5 applications deployed');
    expect(pill).toHaveAttribute('title', expect.stringMatching(/^2 applications and 1 private worker of the 5 your subscription allows\./));
  });

  it('over the limit (a plan lowered): nothing is taken away, and it says how many to delete', () => {
    usage = { limit: 2, current: 3, privateWorkers: 0, remaining: 0, source: 'plan' };
    renderAt();
    expect(screen.getByTestId('applications-limit-notice')).toHaveTextContent('Everything you have keeps running');
    expect(screen.getByTestId('applications-limit-notice')).toHaveTextContent('delete 2 you no longer need');
  });

  it('shows no pill and blocks nothing while the usage is unknown — the API still refuses', () => {
    usage = undefined;
    renderAt();
    expect(screen.queryByTestId('applications-usage')).toBeNull();
    expect(screen.getByTestId('deploy-button')).toBeEnabled();
  });
});

describe('Applications page — Private Workers tab', () => {
  it('comes after Custom Containers when the subscription allows it', () => {
    workersListed = true;
    renderAt();
    const tabs = screen.getAllByTestId(/^tab-/).map((t) => t.getAttribute('data-testid'));
    expect(tabs.slice(-2)).toEqual(['tab-custom', 'tab-workers']);
  });

  it('is absent when the subscription does not include it', () => {
    renderAt();
    expect(screen.queryByTestId('tab-workers')).toBeNull();
  });

  it('★ a deep link waits for the tab to be known instead of falling back to Installed', () => {
    // First render: the worker list has not answered yet, so the tab reads as hidden.
    workersSettled = false;
    workersListed = false;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A fresh element each time: React skips re-rendering an identical one.
    const tree = () => (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/applications/workers']}><Applications key={String(workersSettled)} /></MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    workersSettled = true;
    workersListed = true;
    rerender(tree());
    expect(screen.getByTestId('private-workers-tab-body')).toBeInTheDocument();
  });

  it('renders the Private Workers page embedded at /applications/workers', () => {
    workersListed = true;
    renderAt('/applications/workers');
    expect(screen.getByTestId('private-workers-tab-body')).toHaveTextContent('true');
    expect(screen.getByTestId('private-workers-tab-body')).toHaveAttribute('data-at-limit', 'false');
  });

  it('★ hands the tab the application limit — a worker counts as an application', () => {
    workersListed = true;
    usage = { limit: 2, current: 2, privateWorkers: 1, remaining: 0, source: 'plan' };
    renderAt('/applications/workers');
    expect(screen.getByTestId('private-workers-tab-body')).toHaveAttribute('data-at-limit', 'true');
    expect(screen.getByTestId('applications-limit-notice')).toHaveTextContent('add a private worker');
  });
});
