import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RouteDetail from '../pages/RouteDetail';
import { apiFetch } from '@/lib/api-client';

// A route's custom error pages: the listed codes are answered with the
// platform's page for that code. There is no page path to fill in — the
// platform's error service cannot read the tenant's files.

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'c1', tenantName: 'Test Corp', isLoading: false })),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
const mockApiFetch = vi.mocked(apiFetch);

const ROUTE = {
  id: 'route-1', domainId: 'd1', hostname: 'shop.example.test', path: '/', targetType: 'deployment', deploymentId: null,
  forceHttps: true, wwwRedirect: 'none', redirectUrl: null, redirectStatusCode: 302, ipAllowlist: null,
  rateLimitRps: null, rateLimitConnections: null, rateLimitBurstMultiplier: null,
  wafEnabled: false, wafMode: 'off', wafDetectionOnly: false, wafOwaspCrs: false, wafAnomalyThreshold: 10, wafExcludedRules: null,
  hstsEnabled: false, hstsMaxAge: 0, hstsIncludeSubdomains: false, hstsPreload: false,
  customErrorCodes: null as string | null, additionalHeaders: null, servicePort: null, siteFolder: null, appRoot: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

let route = { ...ROUTE };
let patched: unknown[] = [];
beforeEach(() => {
  route = { ...ROUTE };
  patched = [];
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/advanced') && init?.method === 'PATCH') {
      patched.push(JSON.parse(String(init.body ?? '{}')));
      return Promise.resolve({ data: route }) as never;
    }
    if (url.endsWith('/routes/route-1')) return Promise.resolve({ data: route }) as never;
    return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } }) as never;
  });
});

async function openErrorPages() {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/domains/d1/routes/route-1']}>
        <Routes>
          <Route path="/domains/:domainId/routes/:routeId" element={<RouteDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await user.click(await screen.findByTestId('tab-advanced'));
  await user.click(await screen.findByTestId('custom-error-pages-section'));
  return user;
}

describe('route custom error pages', () => {
  it('asks only for the codes, and says the platform shows a page naming the error', async () => {
    await openErrorPages();
    expect(screen.getByTestId('error-codes-input')).toBeInTheDocument();
    expect(screen.queryByTestId('error-pages-path-input')).toBeNull();
    const form = screen.getByTestId('error-pages-form');
    expect(form).toHaveTextContent('page naming the error');
    expect(form).toHaveTextContent('same status code');
    expect(form).not.toHaveTextContent(/file storage/i);
  });

  it('saves the trimmed codes and nothing else', async () => {
    const user = await openErrorPages();
    await user.type(screen.getByTestId('error-codes-input'), ' 404, 500-599 ');
    await user.click(screen.getByTestId('save-error-pages'));
    await waitFor(() => expect(patched).toEqual([{ custom_error_codes: '404, 500-599' }]));
  });

  it('refuses a code below 400 before it is sent', async () => {
    const user = await openErrorPages();
    await user.type(screen.getByTestId('error-codes-input'), '200');
    expect(screen.getByTestId('error-codes-validation-error')).toHaveTextContent('outside 400–599');
    expect(screen.getByTestId('error-codes-input')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('save-error-pages')).toBeDisabled();
    expect(patched).toEqual([]);
  });

  it('clearing the field turns the pages off', async () => {
    route = { ...ROUTE, customErrorCodes: '404' };
    const user = await openErrorPages();
    await user.clear(screen.getByTestId('error-codes-input'));
    expect(screen.queryByTestId('error-codes-validation-error')).toBeNull();
    await user.click(screen.getByTestId('save-error-pages'));
    await waitFor(() => expect(patched).toEqual([{ custom_error_codes: null }]));
  });
});
