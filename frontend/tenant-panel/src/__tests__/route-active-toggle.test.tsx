/**
 * A route can be switched off without losing its settings, from the domain's
 * route list and from the route's own page. The pill says the state in words —
 * Active / Inactive — and is the switch; switching off is confirmed first.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DomainDetail from '../pages/DomainDetail';
import RouteDetail from '../pages/RouteDetail';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'c1', tenantName: 'Test Corp', isLoading: false })),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

const DOMAIN = {
  id: 'd1', tenantId: 'c1', domainName: 'example.com', status: 'active', dnsMode: 'primary',
  sslAutoRenew: 1, createdAt: '2026-01-10T00:00:00Z',
};
const BASE_ROUTE = {
  domainId: 'd1', path: '/', targetType: 'deployment', deploymentId: null, privateWorkerId: null,
  ingressCname: 'x', nodeHostname: null, isApex: 0, tlsMode: 'auto', status: 'active',
  forceHttps: true, wwwRedirect: 'none', redirectUrl: null, redirectStatusCode: 302, ipAllowlist: null,
  rateLimitRps: null, rateLimitConnections: null, rateLimitBurstMultiplier: null,
  wafEnabled: false, wafMode: 'off', wafDetectionOnly: false, wafOwaspCrs: false, wafAnomalyThreshold: 10, wafExcludedRules: null,
  hstsEnabled: false, hstsMaxAge: 0, hstsIncludeSubdomains: false, hstsPreload: false,
  customErrorCodes: null, customErrorPath: null, additionalHeaders: null, servicePort: null, siteFolder: null, appRoot: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

/** The server's copy of each route; a PATCH changes it, so a refetch shows the new state. */
let routes: Array<typeof BASE_ROUTE & { id: string; hostname: string; enabled: boolean }> = [];
let patches: Array<{ url: string; body: unknown }> = [];
let failPatch: Error | null = null;

beforeEach(() => {
  routes = [
    { ...BASE_ROUTE, id: 'route-1', hostname: 'moodle.example.com', enabled: true },
    { ...BASE_ROUTE, id: 'route-2', hostname: 'old.example.com', enabled: false },
  ];
  patches = [];
  failPatch = null;
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
    const one = /\/routes\/(route-\d)$/.exec(url)?.[1];
    if (one && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body ?? '{}')) as { enabled?: boolean };
      patches.push({ url, body });
      if (failPatch) return Promise.reject(failPatch) as never;
      routes = routes.map((r) => (r.id === one ? { ...r, ...body } : r));
      return Promise.resolve({ data: routes.find((r) => r.id === one) }) as never;
    }
    if (one) return Promise.resolve({ data: routes.find((r) => r.id === one) }) as never;
    if (url.endsWith('/domains/d1/routes')) return Promise.resolve({ data: routes }) as never;
    if (url.includes('/platform/ingress-base-domain')) return Promise.resolve({ data: { ingressBaseDomain: 'ingress.example.net' } }) as never;
    if (url.includes('/domains') && !url.includes('/dns-records')) {
      return Promise.resolve({ data: [DOMAIN], pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 } }) as never;
    }
    return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } }) as never;
  });
});

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/domains/:domainId" element={<DomainDetail />} />
          <Route path="/domains/:domainId/routes/:routeId" element={<RouteDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('route list — Active / Inactive pill', () => {
  it('says each route\'s state in words, and greys an inactive hostname', async () => {
    renderAt('/domains/d1');
    const on = await screen.findByTestId('route-active-toggle-route-1');
    const off = screen.getByTestId('route-active-toggle-route-2');
    expect(on).toHaveTextContent('Active');
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(on.className).toContain('bg-green-50');
    expect(off).toHaveTextContent('Inactive');
    expect(off).toHaveAttribute('aria-checked', 'false');
    expect(off.className).toContain('bg-gray-100');
    expect(within(screen.getByTestId('route-row-route-2')).getByText('old.example.com').className).toContain('text-gray-500');
  });

  it('asks before switching a route off; Cancel changes nothing', async () => {
    const user = userEvent.setup();
    renderAt('/domains/d1');
    await user.click(await screen.findByTestId('route-active-toggle-route-1'));
    const dialog = screen.getByTestId('deactivate-route-confirm');
    expect(dialog).toHaveTextContent('moodle.example.com stops being served');
    expect(dialog).toHaveTextContent('its settings, DNS records and certificate are kept');
    await user.click(screen.getByTestId('deactivate-route-cancel'));
    expect(screen.queryByTestId('deactivate-route-confirm')).toBeNull();
    expect(screen.getByTestId('route-active-toggle-route-1')).toHaveFocus();
    expect(patches).toEqual([]);
    // The click stayed on the pill: the row did not open the route page.
    expect(screen.getByTestId('routes-table')).toBeInTheDocument();
  });

  it('switches a route off after confirming, says so while it runs, and then shows it Inactive', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation(((url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? gate.then(() => original(url, init)) : original(url, init)) as never);
    const user = userEvent.setup();
    renderAt('/domains/d1');
    await user.click(await screen.findByTestId('route-active-toggle-route-1'));
    await user.click(screen.getByTestId('deactivate-route-confirm-button'));

    expect(await screen.findByTestId('route-operation-pending')).toHaveTextContent(
      'Deactivating moodle.example.com — taking its ingress rule down; its settings are kept…',
    );
    expect(screen.getByTestId('route-active-toggle-route-1')).toBeDisabled();
    release();

    await waitFor(() => expect(screen.getByTestId('route-active-toggle-route-1')).toHaveTextContent('Inactive'));
    expect(patches).toEqual([{ url: '/api/v1/tenants/c1/domains/d1/routes/route-1', body: { enabled: false } }]);
    expect(screen.getByTestId('routes-table')).toBeInTheDocument();
  });

  it('switches an inactive route back on straight away', async () => {
    const user = userEvent.setup();
    renderAt('/domains/d1');
    await user.click(await screen.findByTestId('route-active-toggle-route-2'));
    expect(screen.queryByTestId('deactivate-route-confirm')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('route-active-toggle-route-2')).toHaveTextContent('Active'));
    expect(patches).toEqual([{ url: '/api/v1/tenants/c1/domains/d1/routes/route-2', body: { enabled: true } }]);
  });

  it('shows why a switch failed and keeps the old state', async () => {
    failPatch = new Error('Ingress route not found');
    const user = userEvent.setup();
    renderAt('/domains/d1');
    await user.click(await screen.findByTestId('route-active-toggle-route-2'));
    const error = await screen.findByTestId('route-toggle-error');
    expect(within(error).getByText(/Ingress route not found/)).toBeInTheDocument();
    expect(screen.getByTestId('route-active-toggle-route-2')).toHaveTextContent('Inactive');
  });
});

describe('route page — Active / Inactive pill, top right', () => {
  it('shows the pill instead of the old status badge, and switches off after confirming', async () => {
    const user = userEvent.setup();
    renderAt('/domains/d1/routes/route-1');
    const pill = await screen.findByTestId('route-active-toggle');
    expect(pill).toHaveTextContent('Active');
    expect(screen.queryByTestId('route-inactive-notice')).toBeNull();
    // No second "active" badge next to the heading.
    expect(screen.getAllByText(/^active$/i).filter((el) => el !== pill)).toEqual([]);

    await user.click(pill);
    await user.click(screen.getByTestId('deactivate-route-confirm-button'));
    await waitFor(() => expect(screen.getByTestId('route-active-toggle')).toHaveTextContent('Inactive'));
    expect(patches).toEqual([{ url: '/api/v1/tenants/c1/domains/d1/routes/route-1', body: { enabled: false } }]);
    expect(screen.getByTestId('route-inactive-notice')).toHaveTextContent('moodle.example.com is not served');
  });

  it('says an inactive route is not served and keeps its settings editable', async () => {
    renderAt('/domains/d1/routes/route-2');
    expect(await screen.findByTestId('route-active-toggle')).toHaveTextContent('Inactive');
    expect(screen.getByTestId('route-inactive-notice')).toHaveTextContent('Its settings below are kept and can still be changed');
    expect(screen.getByTestId('force-https-toggle')).toBeEnabled();
  });
});
