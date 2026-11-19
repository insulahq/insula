import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RouteDetail from '../pages/RouteDetail';
import { apiFetch } from '@/lib/api-client';

// The WAF Log says who sent a request and whether it was blocked: an address
// on the platform allowlist or one of the route's trusted IPs is "not
// blocked"; the summary names its top addresses and groups by source; an
// address can be trusted from there; the event list filters and pages on the
// server; and an exclusion can cover every rule on one path.

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
  wafEnabled: true, wafMode: 'enforced', wafDetectionOnly: false, wafOwaspCrs: false, wafAnomalyThreshold: 10, wafExcludedRules: null,
  hstsEnabled: false, hstsMaxAge: 0, hstsIncludeSubdomains: false, hstsPreload: false,
  customErrorCodes: null, additionalHeaders: null, servicePort: null, siteFolder: null, appRoot: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id, routeId: 'route-1', ruleId: '941100', severity: 'critical', message: 'XSS Attack Detected via libinjection',
  requestUri: '/mcp', requestMethod: 'POST', sourceIp: '203.0.113.7', createdAt: '2026-01-01T00:00:00Z',
  detectionOnly: false, passReason: null, ...over,
});
const SUMMARY = {
  requests: 830, notBlocked: 824, truncated: false,
  rows: [{
    hostname: 'shop.example.test', ruleId: '941100', message: 'XSS Attack Detected via libinjection', path: '/mcp',
    requests: 830, detectionOnly: 0, notBlocked: 824, sourceIps: 4,
    topSourceIps: [{ sourceIp: '203.0.113.7', requests: 824 }, { sourceIp: '198.51.100.9', requests: 4 }],
    firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T01:00:00.000Z',
  }],
};
const SOURCES = {
  truncated: false,
  rows: [
    { sourceIp: '203.0.113.7', requests: 824, notBlocked: 824, passReasons: ['allowlisted_ip'], topRules: ['941160', '941100'], paths: 1, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T01:00:00.000Z', trusted: false },
    { sourceIp: '198.51.100.9', requests: 4, notBlocked: 0, passReasons: [], topRules: ['930120'], paths: 2, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:30:00.000Z', trusted: true },
  ],
};

let logUrls: string[] = [];
let posts: Array<{ url: string; body: unknown }> = [];
let trusted: unknown[] = [];
beforeEach(() => {
  logUrls = [];
  posts = [];
  trusted = [];
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      posts.push({ url, body });
      if (url.endsWith('/waf-trusted-ips')) {
        const row = { id: `t${trusted.length + 1}`, routeId: 'route-1', value: body.value, note: body.note ?? null, createdBy: 'me', createdAt: '2026-01-02T00:00:00.000Z' };
        trusted = [...trusted, row];
        return Promise.resolve({ data: row }) as never;
      }
      return Promise.resolve({ data: { id: 'x9', ...body } }) as never;
    }
    if (url.includes('/waf-logs/summary')) return Promise.resolve({ data: SUMMARY }) as never;
    if (url.includes('/waf-logs/sources')) return Promise.resolve({ data: SOURCES }) as never;
    if (url.includes('/waf-logs?')) {
      logUrls.push(url);
      const q = new URL(url, 'http://x').searchParams;
      if (q.get('cursor') === 'c2') {
        return Promise.resolve({ data: [entry('l3', { sourceIp: '198.51.100.9' })], pagination: { cursor: null, has_more: false, page_size: 1, total_count: 3 } }) as never;
      }
      const rows = q.get('sourceIp') === '198.51.100.9'
        ? [entry('l2', { sourceIp: '198.51.100.9' })]
        : [entry('l1', { passReason: 'allowlisted_ip' }), entry('l2', { sourceIp: '198.51.100.9', passReason: 'trusted_ip' })];
      return Promise.resolve({ data: rows, pagination: { cursor: 'c2', has_more: !q.get('sourceIp'), page_size: rows.length, total_count: q.get('sourceIp') ? 1 : 3 } }) as never;
    }
    if (url.endsWith('/waf-trusted-ips')) return Promise.resolve({ data: { trustedIps: trusted, max: 20 } }) as never;
    if (url.endsWith('/waf-exclusions')) return Promise.resolve({ data: { exclusions: [] } }) as never;
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

async function openWafLog() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByTestId('tab-security'));
  await user.click(await screen.findByTestId('waf-section'));
  await user.click(screen.getByTestId('toggle-waf-log'));
  return user;
}

const lastLogQuery = () => new URL(logUrls[logUrls.length - 1]!, 'http://x').searchParams;

describe('route WAF log — who, and whether it was blocked', () => {
  it('marks requests the WAF let through with the reason', async () => {
    await openWafLog();
    expect(await screen.findByTestId('waf-log-detected-l1')).toHaveTextContent('not blocked · platform allowlist');
    expect(screen.getByTestId('waf-log-detected-l2')).toHaveTextContent('not blocked · trusted IP');
    expect(screen.getByTestId('waf-summary-total')).toHaveTextContent('830 requests matched rules — 824 not blocked');
    expect(screen.getByTestId('waf-summary-not-blocked-941100-/mcp')).toHaveTextContent('824 not blocked');
  });

  it('names the top addresses of a rule and path; one click shows only its events', async () => {
    const user = await openWafLog();
    const ip = await screen.findByTestId('waf-summary-ip-941100-203.0.113.7');
    expect(ip).toHaveTextContent('203.0.113.7 ×824');
    expect(screen.getByTestId('waf-summary-row-941100-/mcp')).toHaveTextContent('+2 more');
    await user.click(screen.getByTestId('waf-summary-ip-941100-198.51.100.9'));
    await waitFor(() => expect(lastLogQuery().get('sourceIp')).toBe('198.51.100.9'));
    expect(screen.getByTestId('waf-log-filter-ip')).toHaveValue('198.51.100.9');
    expect(await screen.findByTestId('waf-log-latest-heading')).toHaveTextContent('Events (1 matching)');
    await user.click(screen.getByTestId('waf-log-filter-clear'));
    await waitFor(() => expect(lastLogQuery().get('sourceIp')).toBeNull());
  });

  it('filters by rule, path and outcome on the server, and checks the input first', async () => {
    const user = await openWafLog();
    await screen.findByTestId('waf-log-entry-l1');
    await user.type(screen.getByTestId('waf-log-filter-rule'), '93x');
    expect(screen.getByTestId('waf-log-filter-error')).toHaveTextContent('digits only');
    expect(screen.getByTestId('waf-log-filter-apply')).toBeDisabled();
    await user.clear(screen.getByTestId('waf-log-filter-rule'));
    await user.type(screen.getByTestId('waf-log-filter-rule'), '941100');
    await user.type(screen.getByTestId('waf-log-filter-path'), '/mcp');
    await user.click(screen.getByTestId('waf-log-filter-apply'));
    await waitFor(() => expect(lastLogQuery().get('ruleId')).toBe('941100'));
    expect(lastLogQuery().get('path')).toBe('/mcp');
    await user.selectOptions(screen.getByTestId('waf-log-filter-outcome'), 'not_blocked');
    await waitFor(() => expect(lastLogQuery().get('outcome')).toBe('not_blocked'));
  });

  it('sorts on the server and pages with the cursor', async () => {
    const user = await openWafLog();
    await screen.findByTestId('waf-log-entry-l1');
    expect(lastLogQuery().get('sort')).toBe('createdAt:desc');
    await user.click(screen.getByTestId('waf-log-sort-sourceIp'));
    await waitFor(() => expect(lastLogQuery().get('sort')).toBe('sourceIp:desc'));
    const more = await screen.findByTestId('waf-log-more');
    expect(more).toHaveTextContent('Show more (2 of 3)');
    await user.click(more);
    expect(await screen.findByTestId('waf-log-entry-l3')).toBeInTheDocument();
    expect(lastLogQuery().get('cursor')).toBe('c2');
    expect(screen.queryByTestId('waf-log-more')).toBeNull();
  });
});

describe('route WAF log — by source IP, and trusting an address', () => {
  it('lists the sources with what was let through, and opens "trust" for one', async () => {
    const user = await openWafLog();
    await user.click(await screen.findByTestId('waf-summary-view-sources'));
    const row = await screen.findByTestId('waf-source-row-203.0.113.7');
    expect(row).toHaveTextContent('824');
    expect(screen.getByTestId('waf-source-not-blocked-203.0.113.7')).toHaveTextContent('none blocked · platform allowlist');
    expect(row).toHaveTextContent('941160, 941100');
    expect(screen.getByTestId('waf-source-trusted-198.51.100.9')).toHaveTextContent('trusted');

    await user.click(screen.getByTestId('waf-source-trust-203.0.113.7'));
    const modal = await screen.findByTestId('add-waf-trusted-ip-modal');
    expect(within(modal).getByTestId('add-waf-trusted-ip-value')).toHaveValue('203.0.113.7');
    await user.type(within(modal).getByTestId('add-waf-trusted-ip-note'), 'my workstation');
    await user.click(within(modal).getByTestId('add-waf-trusted-ip-submit'));
    await waitFor(() => expect(posts.find((p) => p.url.endsWith('/waf-trusted-ips'))?.body).toEqual({ value: '203.0.113.7', note: 'my workstation' }));
    expect(await screen.findByTestId('waf-trusted-ip-row-t1')).toHaveTextContent('my workstation');
    expect(screen.queryByTestId('add-waf-trusted-ip-modal')).toBeNull();
  });

  it('the Trusted IPs card says what trusting does and refuses a malformed value before sending it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('tab-security'));
    await user.click(await screen.findByTestId('waf-trusted-ips-section'));
    expect(screen.getByTestId('waf-trusted-ips-body')).toHaveTextContent('never blocked');
    expect(screen.getByTestId('waf-trusted-ips-empty')).toBeInTheDocument();
    await user.click(screen.getByTestId('waf-trusted-ips-add'));
    await user.type(screen.getByTestId('add-waf-trusted-ip-value'), 'office');
    expect(screen.getByTestId('add-waf-trusted-ip-value-error')).toBeInTheDocument();
    expect(screen.getByTestId('add-waf-trusted-ip-submit')).toBeDisabled();
    expect(posts).toHaveLength(0);
  });
});

describe('WAF exclusion of every rule on one path', () => {
  it('hides the rule id, needs a path, and sends rule 0 with scope all_rules', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('tab-security'));
    await user.click(await screen.findByTestId('waf-exclusions-section'));
    await user.click(screen.getByTestId('waf-exclusions-add'));
    await user.selectOptions(screen.getByTestId('add-waf-exclusion-scope'), 'all_rules');
    expect(screen.queryByTestId('add-waf-exclusion-rule-id')).toBeNull();
    expect(screen.getByTestId('add-waf-exclusion-all-rules-help')).toHaveTextContent('not checked by any rule');
    await user.type(screen.getByTestId('add-waf-exclusion-reason'), 'MCP endpoint posts HTML');
    expect(screen.getByTestId('add-waf-exclusion-path-error')).toHaveTextContent('needs a path');
    expect(screen.getByTestId('add-waf-exclusion-submit')).toBeDisabled();
    await user.type(screen.getByTestId('add-waf-exclusion-path-regex'), '^/mcp$');
    await user.click(screen.getByTestId('add-waf-exclusion-submit'));
    await waitFor(() => expect(posts.find((p) => p.url.endsWith('/waf-exclusions'))?.body).toEqual({
      ruleId: '0', pathRegex: '^/mcp$', scope: 'all_rules', reason: 'MCP endpoint posts HTML',
    }));
  });
});
