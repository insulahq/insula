import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

// Private workers ride on "Allow Custom Containers". The two inputs — the
// subscription's effective flag and the tenant's existing workers — are
// mocked at their hooks; the gate hook between them and the UI is real.
let allowCustomContainers: boolean | undefined = true;
let subscriptionFailed = false;
let workerItems: unknown[] = [];
const usePrivateWorkersMock = vi.fn((tenantId: string | undefined) => ({
  data: tenantId ? { data: { items: workerItems } } : undefined,
  isLoading: false,
  error: null,
}));

vi.mock('@/hooks/use-subscription', () => ({
  useSubscription: () => ({
    data: subscriptionFailed || allowCustomContainers === undefined ? undefined : { data: { allowCustomContainers } },
    isError: subscriptionFailed,
  }),
}));
vi.mock('@/hooks/use-private-workers', async (orig) => ({
  ...(await orig<typeof import('@/hooks/use-private-workers')>()),
  usePrivateWorkers: (tenantId: string | undefined) => usePrivateWorkersMock(tenantId),
}));
vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: () => ({ tenantId: 't1', tenantName: 'Acme', isLoading: false }),
}));
vi.mock('@/hooks/use-can-manage', () => ({ useCanManage: () => true }));
vi.mock('@/hooks/use-system-info', () => ({
  useSystemInfo: () => ({ data: { platformName: 'Insula' } }),
}));

const { default: Sidebar } = await import('../components/layout/Sidebar');
const { default: PrivateWorkers } = await import('../pages/PrivateWorkers');
const { usePrivateWorkersAccess } = await import('../hooks/use-private-workers-access');

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const WORKER = {
  id: 'w1', tenantId: 't1', name: 'home-gpu', slug: 'home-gpu-ab12', status: 'active',
  exposedPort: 20001, description: null, lastSeenAt: null, createdAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  allowCustomContainers = true;
  subscriptionFailed = false;
  workerItems = [];
  usePrivateWorkersMock.mockClear();
});

function Listed() {
  const access = usePrivateWorkersAccess('t1');
  return <span data-testid="listed">{access.listed ? 'listed' : 'hidden'}</span>;
}

// The page is the Applications page's Private Workers tab now; whether the
// tab shows is this hook's `listed` (applications-page.test.tsx renders it).
describe('the Private Workers tab follows "Allow Custom Containers"', () => {
  it('is listed when the subscription allows custom containers', () => {
    wrap(<Listed />);
    expect(screen.getByTestId('listed')).toHaveTextContent('listed');
  });

  it('is hidden when the subscription does not, and the tenant has no workers', () => {
    allowCustomContainers = false;
    wrap(<Listed />);
    expect(screen.getByTestId('listed')).toHaveTextContent('hidden');
  });

  it('stays while the tenant still has workers to manage', () => {
    allowCustomContainers = false;
    workerItems = [WORKER];
    wrap(<Listed />);
    expect(screen.getByTestId('listed')).toHaveTextContent('listed');
  });

  it('asks for the worker list only once the subscription has said no', () => {
    wrap(<Listed />);
    expect(usePrivateWorkersMock.mock.calls.every(([t]) => t === undefined)).toBe(true);

    allowCustomContainers = undefined; // still loading
    wrap(<Listed />);
    expect(screen.getAllByTestId('listed').at(-1)).toHaveTextContent('hidden');
    expect(usePrivateWorkersMock.mock.calls.every(([t]) => t === undefined)).toBe(true);
  });

  it('is no longer a sidebar entry of its own', () => {
    wrap(<Sidebar open onClose={() => {}} />);
    expect(screen.queryByRole('link', { name: /Private Workers/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Applications/ })).toBeInTheDocument();
  });
});

describe('a subscription that cannot be read opens the panel — the API still gates', () => {
  it('keeps the tab listed', () => {
    subscriptionFailed = true;
    wrap(<Listed />);
    expect(screen.getByTestId('listed')).toHaveTextContent('listed');
  });

  it('offers Create on the page', () => {
    subscriptionFailed = true;
    wrap(<PrivateWorkers />);
    expect(screen.getByTestId('add-private-worker-button-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('private-workers-not-in-plan')).toBeNull();
  });
});

describe('Private Workers page — creating needs "Allow Custom Containers"', () => {
  it('offers Create when allowed, with no plan notice', () => {
    wrap(<PrivateWorkers />);
    expect(screen.getByTestId('add-private-worker-button-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('private-workers-not-in-plan')).toBeNull();
  });

  it('says why and offers no Create when not allowed', () => {
    allowCustomContainers = false;
    wrap(<PrivateWorkers />);
    expect(screen.getByTestId('private-workers-not-in-plan')).toHaveTextContent('not included in your plan');
    expect(screen.queryByTestId('add-private-worker-button-empty')).toBeNull();
    expect(screen.queryByTestId('add-private-worker-button')).toBeNull();
  });

  it('still lists existing workers without Create, and says they keep running', () => {
    allowCustomContainers = false;
    workerItems = [WORKER];
    wrap(<PrivateWorkers />);
    expect(screen.getByTestId('pw-row-w1')).toBeInTheDocument();
    expect(screen.queryByTestId('add-private-worker-button')).toBeNull();
    expect(screen.getByTestId('private-workers-not-in-plan')).toHaveTextContent('keep running');
  });

  it('shows the header Create beside existing workers when allowed', () => {
    workerItems = [WORKER];
    wrap(<PrivateWorkers />);
    expect(screen.getByTestId('add-private-worker-button')).toBeInTheDocument();
  });
});
