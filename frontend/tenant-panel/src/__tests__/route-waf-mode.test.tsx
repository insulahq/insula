import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import RouteDetail from '../pages/RouteDetail';
import { apiFetch } from '@/lib/api-client';

// A route's WAF is Off | Detection only | Enforced. Detection only checks and
// logs every request but blocks nothing; its events show in the WAF Log marked
// "detected · not blocked".

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
  wafEnabled: true, wafMode: 'detection', wafDetectionOnly: true, wafOwaspCrs: false, wafAnomalyThreshold: 10, wafExcludedRules: null,
  hstsEnabled: false, hstsMaxAge: 0, hstsIncludeSubdomains: false, hstsPreload: false,
  customErrorCodes: null, customErrorPath: null, additionalHeaders: null, servicePort: null, siteFolder: null, appRoot: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const LOGS = [
  { id: 'l1', routeId: 'route-1', ruleId: '941100', severity: 'critical', message: 'XSS Attack Detected via libinjection', requestUri: '/?q=<script>', requestMethod: 'GET', sourceIp: '192.0.2.60', createdAt: '2026-01-01T00:00:00Z', detectionOnly: true },
  { id: 'l2', routeId: 'route-1', ruleId: '942100', severity: 'critical', message: 'SQL Injection Attack', requestUri: '/?id=1', requestMethod: 'GET', sourceIp: '192.0.2.61', createdAt: '2026-01-01T00:00:01Z', detectionOnly: false },
];

let patched: unknown[] = [];
let exclusions: unknown[] = [];
const SUMMARY = { requests: 0, rows: [], truncated: false };
beforeEach(() => {
  patched = [];
  exclusions = [];
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/security') && init?.method === 'PATCH') {
      patched.push(JSON.parse(String(init.body ?? '{}')));
      return Promise.resolve({ data: { ...ROUTE, wafMode: 'enforced', wafDetectionOnly: false } }) as never;
    }
    if (url.includes('/waf-logs/summary')) return Promise.resolve({ data: SUMMARY }) as never;
    if (url.endsWith('/waf-logs')) return Promise.resolve({ data: LOGS }) as never;
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

async function openWaf() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByTestId('tab-security'));
  await user.click(await screen.findByTestId('waf-section'));
  return user;
}

describe('route WAF mode', () => {
  it('shows the saved mode as a three-way choice, with what it does', async () => {
    await openWaf();
    expect(screen.getByTestId('waf-mode-badge')).toHaveTextContent('Detection only');
    expect(screen.getByTestId('waf-mode-detection')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('waf-mode-off')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('waf-mode-enforced')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('waf-mode-help')).toHaveTextContent('nothing is blocked');
    expect(screen.queryByTestId('waf-enabled-toggle')).toBeNull();
  });

  it('saves the chosen mode', async () => {
    const user = await openWaf();
    expect(screen.getByTestId('save-waf')).toBeDisabled();
    await user.click(screen.getByTestId('waf-mode-enforced'));
    expect(screen.getByTestId('waf-mode-help')).toHaveTextContent('blocked (403)');
    await user.click(screen.getByTestId('save-waf'));
    await waitFor(() => expect(patched).toEqual([{ waf_mode: 'enforced' }]));
  });

  it('is one tab stop; arrow keys move and choose', async () => {
    const user = await openWaf();
    expect(['off', 'detection', 'enforced'].map((m) => screen.getByTestId(`waf-mode-${m}`).getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    screen.getByTestId('waf-mode-detection').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('waf-mode-enforced')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('waf-mode-enforced')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('waf-mode-off')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('save-waf')).toBeEnabled();
  });

  it('marks the events logged in detection-only mode as not blocked', async () => {
    const user = await openWaf();
    await user.click(screen.getByTestId('toggle-waf-log'));
    expect(await screen.findByTestId('waf-log-detected-l1')).toHaveTextContent('detected · not blocked');
    expect(screen.queryByTestId('waf-log-detected-l2')).toBeNull();
  });
});

// Times read in the viewer's zone, the column header names it, and UTC stays
// on hover. Tokyo has no daylight saving, so the offset never depends on the
// day the suite runs.
describe('route WAF times', () => {
  beforeEach(() => { vi.stubEnv('TZ', 'Asia/Tokyo'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('a WAF log entry reads in local time, under a header naming the zone', async () => {
    const user = await openWaf();
    await user.click(screen.getByTestId('toggle-waf-log'));
    const row = await screen.findByTestId('waf-log-entry-l1');
    expect(within(row).getByText('2026-01-01 09:00')).toHaveAttribute('title', '2026-01-01 00:00 UTC');
    const header = within(screen.getByTestId('waf-log-entries')).getByText(/^Time \(UTC\+9\)/);
    expect(header.getAttribute('title')).toContain('Asia/Tokyo');
  });

  it('an exclusion\'s "added" time reads in local time too', async () => {
    exclusions = [{
      id: '00000000-0000-4000-8000-0000000000e1', ruleId: '941100', hostnameRegex: '^shop\\.example\\.test$', scope: 'full_disable',
      reason: 'search box', createdBy: 'tenant-user', createdAt: '2026-10-23T18:05:09.000Z', updatedAt: '2026-10-23T18:05:09.000Z',
      disabled: false, tenantId: 'c1', routeId: 'route-1',
    }];
    const user = await openWaf();
    await user.click(await screen.findByTestId('waf-exclusions-section'));
    const row = await screen.findByTestId('waf-exclusion-row-00000000-0000-4000-8000-0000000000e1');
    expect(within(row).getByText('2026-10-24 03:05')).toHaveAttribute('title', '2026-10-23 18:05 UTC');
    expect(within(screen.getByTestId('waf-exclusions-body')).getByText('Added (UTC+9)')).toBeInTheDocument();
  });
});
