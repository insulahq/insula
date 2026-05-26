import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DomainsTab from '../pages/tenants/DomainsTab';
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

const MOCK_CLIENTS = [
  { id: 'tenant-1', name: 'Acme Corp', status: 'active' as const },
  { id: 'tenant-2', name: 'Beta Inc', status: 'active' as const },
];

const MOCK_DOMAINS = [
  {
    id: 'domain-1',
    tenantId: 'tenant-1',
    domainName: 'example.com',
    status: 'active' as const,
    dnsMode: 'cname',
    sslAutoRenew: 1,
    createdAt: '2026-01-10T00:00:00Z',
  },
  {
    id: 'domain-2',
    tenantId: 'tenant-1',
    domainName: 'test.org',
    status: 'pending' as const,
    dnsMode: 'primary',
    sslAutoRenew: 0,
    createdAt: '2026-02-15T00:00:00Z',
  },
];

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

function setupMockApi() {
  mockApiFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.match(/\/tenants\/tenant-\d+$/)) {
      const id = url.split('/').pop();
      const tenant = MOCK_CLIENTS.find((c) => c.id === id);
      return Promise.resolve({ data: tenant ?? null });
    }
    if (typeof url === 'string' && url.includes('/tenants') && !url.includes('/domains')) {
      if (url.includes('search=')) {
        return Promise.resolve({
          data: MOCK_CLIENTS,
          pagination: { total_count: 2, cursor: null, has_more: false, page_size: 20 },
        });
      }
      return Promise.resolve({
        data: [],
        pagination: { total_count: 0, cursor: null, has_more: false, page_size: 0 },
      });
    }
    if (typeof url === 'string' && url.includes('/domains')) {
      return Promise.resolve({
        data: MOCK_DOMAINS,
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 },
      });
    }
    return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DomainsTab', () => {
  // Heading "Domains" lives on the parent TenantsLayout. We assert
  // tab-body affordances here. The Add Domain button + modal were
  // removed when Domains became a read/manage tab — adding domains
  // is now a tenant-scoped operation accessed from Tenant Detail.
  it('renders with searchable tenant selector', () => {
    render(<DomainsTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tenant-search-select')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tenants...')).toBeInTheDocument();
  });

  it('shows all tenants by default without a prompt to select', () => {
    render(<DomainsTab />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('select-tenant-prompt')).not.toBeInTheDocument();
  });

  it('does NOT render an Add Domain button (read-only cross-tenant view)', () => {
    render(<DomainsTab />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('add-domain-button')).not.toBeInTheDocument();
  });

  it('has a search input', () => {
    render(<DomainsTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('domain-search')).toBeInTheDocument();
  });
});

describe('Domain row click', () => {
  async function selectTenantAndWaitForDomains() {
    const user = userEvent.setup();
    setupMockApi();
    render(<DomainsTab />, { wrapper: createWrapper() });

    const searchInput = screen.getByTestId('tenant-search-input');
    await user.type(searchInput, 'Acme');

    await waitFor(() => {
      expect(screen.getByTestId('tenant-option-tenant-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('tenant-option-tenant-1'));

    await waitFor(() => {
      expect(screen.getByTestId('domain-row-domain-1')).toBeInTheDocument();
    });

    return user;
  }

  it('domain rows are clickable', async () => {
    await selectTenantAndWaitForDomains();
    expect(screen.getByTestId('domain-row-domain-1')).toHaveClass('cursor-pointer');
  });
});
