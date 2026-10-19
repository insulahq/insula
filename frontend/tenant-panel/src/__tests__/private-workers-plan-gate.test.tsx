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

describe('Sidebar — Private Workers follows "Allow Custom Containers"', () => {
  it('lists the page when the subscription allows custom containers', () => {
    wrap(<Sidebar open onClose={() => {}} />);
    expect(screen.getByRole('link', { name: /Private Workers/ })).toBeInTheDocument();
  });

  it('hides it when the subscription does not, and the tenant has no workers', () => {
    allowCustomContainers = false;
    wrap(<Sidebar open onClose={() => {}} />);
    expect(screen.queryByRole('link', { name: /Private Workers/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Applications/ })).toBeInTheDocument();
  });

  it('keeps it while the tenant still has workers to manage', () => {
    allowCustomContainers = false;
    workerItems = [WORKER];
    wrap(<Sidebar open onClose={() => {}} />);
    expect(screen.getByRole('link', { name: /Private Workers/ })).toBeInTheDocument();
  });

  it('asks for the worker list only once the subscription has said no', () => {
    wrap(<Sidebar open onClose={() => {}} />);
    expect(usePrivateWorkersMock.mock.calls.every(([t]) => t === undefined)).toBe(true);

    allowCustomContainers = undefined; // still loading
    wrap(<Sidebar open onClose={() => {}} />);
    expect(screen.getAllByTestId('sidebar').at(-1)?.textContent).not.toContain('Private Workers');
    expect(usePrivateWorkersMock.mock.calls.every(([t]) => t === undefined)).toBe(true);
  });
});

describe('a subscription that cannot be read opens the panel — the API still gates', () => {
  it('keeps the page listed', () => {
    subscriptionFailed = true;
    wrap(<Sidebar open onClose={() => {}} />);
    expect(screen.getByRole('link', { name: /Private Workers/ })).toBeInTheDocument();
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
