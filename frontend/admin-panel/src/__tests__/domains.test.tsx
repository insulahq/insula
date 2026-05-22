import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Domains from '../pages/Domains';
import CreateDomainModal from '../components/CreateDomainModal';
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
    // Single tenant fetch for selected tenant display
    if (typeof url === 'string' && url.match(/\/tenants\/tenant-\d+$/)) {
      const id = url.split('/').pop();
      const tenant = MOCK_CLIENTS.find((c) => c.id === id);
      return Promise.resolve({ data: tenant ?? null });
    }
    // Tenant search
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

describe('Domains page', () => {
  it('renders with searchable tenant selector', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tenant-search-select')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tenants...')).toBeInTheDocument();
  });

  it('shows all tenants by default without a prompt to select', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('select-tenant-prompt')).not.toBeInTheDocument();
  });

  it('add domain button is always enabled', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('add-domain-button')).toBeEnabled();
  });

  it('has a search input', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('domain-search')).toBeInTheDocument();
  });
});

describe('CreateDomainModal', () => {
  it('renders form fields when open', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('create-domain-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add Domain' })).toBeInTheDocument();
    expect(screen.getByTestId('domain-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('dns-mode-select')).toBeInTheDocument();
  });

  it('is hidden when closed', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={false} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByTestId('create-domain-modal')).not.toBeInTheDocument();
  });

  it('has required domain name field', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('domain-name-input')).toBeRequired();
  });

  it('has required dns mode field', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('dns-mode-select')).toBeRequired();
  });

  it('defaults dns mode to cname', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    const select = screen.getByTestId('dns-mode-select') as HTMLSelectElement;
    expect(select.value).toBe('cname');
  });

  it('has submit and cancel buttons', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('submit-domain-button')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});

describe('Domain row expansion', () => {
  async function selectTenantAndWaitForDomains() {
    const user = userEvent.setup();
    setupMockApi();
    render(<Domains />, { wrapper: createWrapper() });

    // Type in the searchable tenant select to find a tenant
    const searchInput = screen.getByTestId('tenant-search-input');
    await user.type(searchInput, 'Acme');

    // Wait for search results to appear
    await waitFor(() => {
      expect(screen.getByTestId('tenant-option-tenant-1')).toBeInTheDocument();
    });

    // Click on the tenant to select it
    await user.click(screen.getByTestId('tenant-option-tenant-1'));

    // Wait for domain rows to appear
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
