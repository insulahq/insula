import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RouteDetail from '../pages/RouteDetail';
import { apiFetch } from '@/lib/api-client';

// A tenant can narrow a WAF exclusion to one path of the route's domain, and
// can let rule 920420 accept text/plain bodies (inspected as JSON) instead of
// switching it off.

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'c1', tenantName: 'Test Corp', isLoading: false })),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
const mockApiFetch = vi.mocked(apiFetch);

const ROUTE = {
  id: 'route-1', domainId: 'd1', hostname: 'moodle.example.test', path: '/', targetType: 'deployment', deploymentId: null,
  forceHttps: true, wwwRedirect: 'none', redirectUrl: null, redirectStatusCode: 302, ipAllowlist: null,
  rateLimitRps: null, rateLimitConnections: null, rateLimitBurstMultiplier: null,
  wafEnabled: true, wafMode: 'detection', wafDetectionOnly: true, wafOwaspCrs: false, wafAnomalyThreshold: 10, wafExcludedRules: null,
  hstsEnabled: false, hstsMaxAge: 0, hstsIncludeSubdomains: false, hstsPreload: false,
  customErrorCodes: null, customErrorPath: null, additionalHeaders: null, servicePort: null, siteFolder: null, appRoot: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const exclusion = (over: Record<string, unknown>) => ({
  id: 'x1', ruleId: '941100', hostnameRegex: '^moodle\\.example\\.test$', pathRegex: null, scope: 'args', reason: 'editor HTML',
  createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', disabled: false,
  tenantId: 'c1', routeId: 'route-1', ...over,
});

let posted: unknown[] = [];
let exclusions: unknown[] = [];
beforeEach(() => {
  posted = [];
  exclusions = [];
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/waf-exclusions') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      posted.push(body);
      return Promise.resolve({ data: exclusion({ id: 'x-new', ...body }) }) as never;
    }
    if (url.endsWith('/waf-logs')) return Promise.resolve({ data: [] }) as never;
    if (url.endsWith('/waf-exclusions')) return Promise.resolve({ data: { exclusions } }) as never;
    if (url.endsWith('/routes/route-1')) return Promise.resolve({ data: ROUTE }) as never;
    return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } }) as never;
  });
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/domains/d1/routes/route-1']}>
        <Routes>
          <Route path="/domains/:domainId/routes/:routeId" element={<RouteDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openExclusions() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByTestId('tab-security'));
  await user.click(await screen.findByTestId('waf-exclusions-section'));
  return user;
}

async function openAdd() {
  const user = await openExclusions();
  await user.click(screen.getByTestId('waf-exclusions-add'));
  await user.type(screen.getByTestId('add-waf-exclusion-reason'), 'H5P beacons');
  return user;
}

describe('route WAF exclusions — path scope', () => {
  it('lists each exclusion with its path, or "every path"', async () => {
    exclusions = [exclusion({}), exclusion({ id: 'x2', ruleId: '920420', pathRegex: '^/lib/ajax/service\\.php$', scope: 'text_plain_as_json' })];
    await openExclusions();
    expect(await screen.findByTestId('waf-exclusion-path-x1')).toHaveTextContent('every path');
    expect(screen.getByTestId('waf-exclusion-path-x2')).toHaveTextContent('^/lib/ajax/service\\.php$');
    expect(screen.getByTestId('waf-exclusion-row-x2')).toHaveTextContent('text/plain as JSON');
  });

  it('posts the path, or null for the whole domain', async () => {
    const user = await openAdd();
    await user.type(screen.getByTestId('add-waf-exclusion-rule-id'), '941100');
    await user.click(screen.getByTestId('add-waf-exclusion-submit'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ ruleId: '941100', pathRegex: null, scope: 'args', reason: 'H5P beacons' });

    await user.click(screen.getByTestId('waf-exclusions-add'));
    await user.type(screen.getByTestId('add-waf-exclusion-rule-id'), '941160');
    await user.type(screen.getByTestId('add-waf-exclusion-path-regex'), '^/mod/forum/post\\.php$');
    await user.type(screen.getByTestId('add-waf-exclusion-reason'), 'forum editor');
    await user.click(screen.getByTestId('add-waf-exclusion-submit'));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ ruleId: '941160', pathRegex: '^/mod/forum/post\\.php$' });
  });

  it('refuses an unanchored path before it reaches the API', async () => {
    const user = await openAdd();
    await user.type(screen.getByTestId('add-waf-exclusion-rule-id'), '941100');
    await user.type(screen.getByTestId('add-waf-exclusion-path-regex'), '/mod/forum');
    expect(screen.getByTestId('add-waf-exclusion-path-error')).toHaveTextContent('must start with ^/');
    expect(screen.getByTestId('add-waf-exclusion-submit')).toBeDisabled();
    // A lookbehind compiles in JavaScript but not in the WAF's PCRE.
    await user.clear(screen.getByTestId('add-waf-exclusion-path-regex'));
    await user.type(screen.getByTestId('add-waf-exclusion-path-regex'), '^/x(?<=a+)');
    expect(screen.getByTestId('add-waf-exclusion-path-error')).toHaveTextContent('the WAF cannot compile');
    expect(screen.getByTestId('add-waf-exclusion-submit')).toBeDisabled();
  });

  it('offers "text/plain as JSON" for rule 920420 only', async () => {
    const user = await openAdd();
    const scope = () => screen.getByTestId('add-waf-exclusion-scope') as HTMLSelectElement;
    await user.type(screen.getByTestId('add-waf-exclusion-rule-id'), '941100');
    expect(within(scope()).queryByRole('option', { name: /text_plain_as_json/ })).toBeNull();

    await user.clear(screen.getByTestId('add-waf-exclusion-rule-id'));
    await user.type(screen.getByTestId('add-waf-exclusion-rule-id'), '920420');
    await user.selectOptions(scope(), 'text_plain_as_json');
    expect(screen.getByTestId('add-waf-exclusion-text-plain-help')).toHaveTextContent('parse it as JSON');
    await user.type(screen.getByTestId('add-waf-exclusion-path-regex'), '^/lib/ajax/service\\.php$');
    await user.click(screen.getByTestId('add-waf-exclusion-submit'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ ruleId: '920420', scope: 'text_plain_as_json', pathRegex: '^/lib/ajax/service\\.php$' });
  });
});
