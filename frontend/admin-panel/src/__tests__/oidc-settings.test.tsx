import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OidcPage from '../pages/security/OidcPage';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function setupMockApi(providers: unknown[] = []) {
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/oidc/providers')) {
      return Promise.resolve({ data: providers });
    }
    if (url.includes('/oidc/settings')) {
      return Promise.resolve({
        data: { disableLocalAuthAdmin: false, disableLocalAuthTenant: false, hasBreakGlassSecret: false },
      });
    }
    return Promise.resolve({ data: null });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OidcPage', () => {
  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<OidcPage />, { wrapper: createWrapper() });
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders page heading and description', async () => {
    setupMockApi();
    render(<OidcPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('OIDC / SSO Configuration')).toBeInTheDocument();
    });
    expect(screen.getByText('Configure identity providers and authentication settings.')).toBeInTheDocument();
  });

  it('shows providers section', async () => {
    setupMockApi();
    render(<OidcPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('providers-section')).toBeInTheDocument();
    });
    expect(screen.getByText('OIDC Providers')).toBeInTheDocument();
  });

  it('shows global settings section', async () => {
    setupMockApi();
    render(<OidcPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('auth-ingress-section')).toBeInTheDocument();
    });
    expect(screen.getByText(/Authentication.*Ingress Protection/)).toBeInTheDocument();
  });

  it('shows add provider button', async () => {
    setupMockApi();
    render(<OidcPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-provider-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Provider')).toBeInTheDocument();
  });

  it('shows empty state when no providers exist', async () => {
    setupMockApi();
    render(<OidcPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No OIDC providers configured.')).toBeInTheDocument();
    });
  });

  it('shows auth toggles in combined section', async () => {
    setupMockApi();
    render(<OidcPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('disable-local-tenant-toggle')).toBeInTheDocument();
    });
    expect(screen.getByTestId('disable-local-admin-toggle')).toBeInTheDocument();
  });

  it('renders provider rows when data is returned', async () => {
    setupMockApi([
      {
        id: 'prov-1',
        displayName: 'Corporate SSO',
        issuerUrl: 'https://dex.example.com',
        tenantId: 'my-tenant',
        panelScope: 'admin',
        enabled: true,
        backchannelLogoutEnabled: false,
        displayOrder: 0,
        discoveryMetadata: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    render(<OidcPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('provider-prov-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Corporate SSO')).toBeInTheDocument();
  });
});

describe('OidcPage — OAuth2 Proxy protection', () => {
  const tenantProviders = [
    { id: 'p-google', displayName: 'Google', panelScope: 'tenant', enabled: true, issuerUrl: 'https://accounts.example.test', clientId: 'a' },
    { id: 'p-accounts', displayName: 'Accounts', panelScope: 'tenant', enabled: true, issuerUrl: 'https://id.example.test', clientId: 'b' },
  ];

  function mockApi(settings: Record<string, unknown>) {
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/oidc/providers')) return Promise.resolve({ data: tenantProviders });
      if (url.includes('/oidc/settings') && init?.method === 'PUT') return Promise.resolve({ data: settings });
      if (url.includes('/oidc/settings')) {
        return Promise.resolve({ data: {
          disableLocalAuthAdmin: false, disableLocalAuthTenant: false, hasBreakGlassSecret: false,
          protectAdminViaProxy: false, protectTenantViaProxy: false, breakGlassPath: null,
          proxyAdminProviderId: null, proxyTenantProviderId: null, ...settings,
        } });
      }
      return Promise.resolve({ data: null });
    });
  }

  it('shows saved protection as ON (the flag names now match the API)', async () => {
    mockApi({ protectTenantViaProxy: true, proxyTenantProviderId: 'p-accounts' });
    render(<OidcPage />, { wrapper: createWrapper() });
    const toggle = await screen.findByTestId('proxy-protect-tenant-toggle');
    expect(toggle).toBeChecked();
    expect(screen.getByTestId('proxy-provider-tenant-select')).toHaveValue('p-accounts');
  });

  it('requires a provider before saving, then sends it', async () => {
    mockApi({});
    render(<OidcPage />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByTestId('proxy-protect-tenant-toggle'));
    // Two tenant providers: nothing is preselected, so Save is blocked.
    expect(screen.getByTestId('save-global-settings')).toBeDisabled();
    fireEvent.change(screen.getByTestId('proxy-provider-tenant-select'), { target: { value: 'p-google' } });
    fireEvent.click(screen.getByTestId('save-global-settings'));
    await waitFor(() => {
      const put = mockApiFetch.mock.calls.find(([u, i]) => String(u).includes('/oidc/settings') && (i as RequestInit | undefined)?.method === 'PUT');
      expect(put).toBeDefined();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toMatchObject({
        proxy_protect_tenant: true,
        proxy_tenant_provider_id: 'p-google',
      });
    });
  });
});

