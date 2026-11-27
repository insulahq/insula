import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DeploymentCredentialsResponse } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import {
  ADMIN_ACCOUNT_PENDING_POLL_MS,
  useDeploymentCredentials,
  useRotateDatabaseAdminPassword,
} from '@/hooks/use-deployments';

// The administrator account is null until the platform has set it up, and the
// credentials read is what starts that. These run the real hooks against a
// mocked transport: the panel must ask again while it is null and stop once
// it is there, and a rotated password must replace the cached one at once.

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: vi.fn(),
}));
const mockApiFetch = vi.mocked(apiFetch);

const CREDENTIALS_PATH = '/api/v1/tenants/t1/deployments/d1/credentials';

function credentials(
  adminAccount: DeploymentCredentialsResponse['adminAccount'],
  adminAccountStatus: DeploymentCredentialsResponse['adminAccountStatus'] = adminAccount ? 'ready' : 'pending',
): { data: DeploymentCredentialsResponse } {
  return {
    data: {
      credentials: {},
      connectionInfo: { host: 'db.tenant-t1.svc.cluster.local', port: 3306, database: null, username: null },
      generatedKeys: [],
      adminAccount,
      adminAccountStatus,
    },
  };
}

function wrapperWith(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

const credentialReads = (): number => mockApiFetch.mock.calls.filter(([path]) => path === CREDENTIALS_PATH).length;

describe('useDeploymentCredentials — waiting for the administrator account', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks again every few seconds while the account is null, and stops once it is there', async () => {
    mockApiFetch
      .mockResolvedValueOnce(credentials(null) as never)
      .mockResolvedValueOnce(credentials(null) as never)
      .mockResolvedValue(credentials({ username: 'dbadmin', password: 'pw-1' }) as never);

    const { result } = renderHook(
      () => useDeploymentCredentials('t1', 'd1', { pollWhileAdminPending: true }),
      { wrapper: wrapperWith(newClient()) },
    );

    await waitFor(() => expect(result.current.data?.data.adminAccount).toBeNull());
    expect(credentialReads()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(ADMIN_ACCOUNT_PENDING_POLL_MS); });
    await waitFor(() => expect(credentialReads()).toBe(2));

    await act(async () => { await vi.advanceTimersByTimeAsync(ADMIN_ACCOUNT_PENDING_POLL_MS); });
    await waitFor(() => expect(result.current.data?.data.adminAccount).toEqual({ username: 'dbadmin', password: 'pw-1' }));
    expect(credentialReads()).toBe(3);

    // Present now: no further reads.
    await act(async () => { await vi.advanceTimersByTimeAsync(ADMIN_ACCOUNT_PENDING_POLL_MS * 4); });
    expect(credentialReads()).toBe(3);
  });

  it.each(['restricted', 'unavailable', 'lost'] as const)('does not poll when the account is %s: asking again changes nothing', async (status) => {
    mockApiFetch.mockResolvedValue(credentials(null, status) as never);

    renderHook(() => useDeploymentCredentials('t1', 'd1', { pollWhileAdminPending: true }), { wrapper: wrapperWith(newClient()) });

    await waitFor(() => expect(credentialReads()).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(ADMIN_ACCOUNT_PENDING_POLL_MS * 4); });
    expect(credentialReads()).toBe(1);
  });

  it('does not poll when the caller has no account to wait for', async () => {
    mockApiFetch.mockResolvedValue(credentials(null) as never);

    renderHook(() => useDeploymentCredentials('t1', 'd1'), { wrapper: wrapperWith(newClient()) });

    await waitFor(() => expect(credentialReads()).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(ADMIN_ACCOUNT_PENDING_POLL_MS * 4); });
    expect(credentialReads()).toBe(1);
  });
});

describe('useRotateDatabaseAdminPassword', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it('POSTs with no body and puts the returned password into the cached credentials', async () => {
    const client = newClient();
    client.setQueryData(['deployment-credentials', 't1', 'd1'], credentials({ username: 'dbadmin', password: 'old-pw' }));
    mockApiFetch.mockImplementation(((path: string) => (path.endsWith('/admin-account/password')
      ? Promise.resolve({ data: { username: 'dbadmin', password: 'new-pw' } })
      : new Promise(() => {}))) as never);

    const { result } = renderHook(() => useRotateDatabaseAdminPassword('t1'), { wrapper: wrapperWith(client) });
    await act(async () => { await result.current.mutateAsync('d1'); });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/tenants/t1/deployments/d1/admin-account/password', { method: 'POST' });
    const cached = client.getQueryData<{ data: DeploymentCredentialsResponse }>(['deployment-credentials', 't1', 'd1']);
    expect(cached?.data.adminAccount).toEqual({ username: 'dbadmin', password: 'new-pw' });
  });
});
