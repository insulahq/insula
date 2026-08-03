import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import Monitoring from '../pages/Monitoring';

const MOCK_AUDIT_ENTRIES = [
  {
    id: 'log-1',
    tenantId: null,
    actionType: 'create',
    resourceType: 'tenant',
    resourceId: 'c-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'POST',
    httpPath: '/api/v1/tenants',
    httpStatus: 201,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'log-2',
    tenantId: 'c-1',
    actionType: 'update',
    resourceType: 'domain',
    resourceId: 'd-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'PATCH',
    httpPath: '/api/v1/tenants/c-1/domains/d-1',
    httpStatus: 500,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'log-3',
    tenantId: null,
    actionType: 'delete',
    resourceType: 'backup',
    resourceId: 'b-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'DELETE',
    httpPath: '/api/v1/backups/b-1',
    httpStatus: 404,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'log-old-1',
    tenantId: null,
    actionType: 'create',
    resourceType: 'region',
    resourceId: 'r-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'POST',
    httpPath: '/api/v1/regions',
    httpStatus: 201,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 days ago
  },
];

vi.mock('@/hooks/use-dashboard', () => ({
  usePlatformStatus: () => ({
    data: { data: { status: 'healthy', timestamp: '2026-03-25T00:00:00Z', version: '1.0.0' } },
  }),
}));

vi.mock('@/hooks/use-audit-logs', () => ({
  useAuditLogs: () => ({
    data: { data: MOCK_AUDIT_ENTRIES },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/use-health', () => ({
  useHealth: () => ({
    data: {
      data: {
        overall: 'healthy',
        checkedAt: new Date().toISOString(),
        services: [
          { name: 'database', status: 'ok', latencyMs: 5, message: null },
        ],
      },
    },
    isLoading: false,
    isFetching: false,
  }),
}));

const MOCK_ALERTS = [
  { ruleId: 'api-error-rate', state: 'firing', severity: 'critical', since: new Date().toISOString(), lastValue: 12, lastNotifiedAt: null, lastEvaluatedAt: null },
  { ruleId: 'disk-pressure', state: 'firing', severity: 'warning', since: new Date().toISOString(), lastValue: 82, lastNotifiedAt: null, lastEvaluatedAt: null },
  { ruleId: 'cert-expiry', state: 'resolved', severity: 'warning', since: new Date(Date.now() - 86_400_000).toISOString(), lastValue: 0, lastNotifiedAt: null, lastEvaluatedAt: null },
];

vi.mock('@/hooks/use-monitoring-alerts', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-monitoring-alerts')>('@/hooks/use-monitoring-alerts');
  return {
    ...actual,
    useMonitoringAlerts: () => ({ data: { data: MOCK_ALERTS }, isLoading: false, error: null }),
  };
});

vi.mock('@/hooks/use-pods', () => ({
  usePods: () => ({
    data: { data: { pods: [], capacity: { used: 5, allocatable: 110 } } },
    isLoading: false,
    isError: false,
  }),
}));

function createWrapper(initialEntries: readonly string[] = ['/monitoring']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[...initialEntries]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('Monitoring page', () => {
  it('renders the page heading', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByRole('heading', { name: 'Monitoring' })).toBeInTheDocument();
  });

  it('shows the 3 real stat cards (placeholder cards removed Wave 2)', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByText('Platform Status')).toBeInTheDocument();
    // "Active Alerts (24h)" appears both as the stat-card title and
    // inside the alert-history tab heading — at least one match is enough.
    expect(screen.getAllByText(/Active Alerts/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Pod Usage')).toBeInTheDocument();
    // Avg Response Time + Error Rate cards intentionally removed —
    // they were hardcoded placeholders.
    expect(screen.queryByText('Avg Response Time')).not.toBeInTheDocument();
    expect(screen.queryByText('Error Rate')).not.toBeInTheDocument();
  });

  // Counts FIRING RULES, not audit rows. It used to read "3" here purely
  // because three audit entries existed inside 24h, so the card was red on a
  // healthy system and its number meant "things happened", not "things broke".
  it('counts firing alerts, not audit entries', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    // 2 firing (1 critical + 1 warning); the resolved one must not count.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('defaults to the SLOs tab', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-slos')).toHaveClass('border-brand-500');
    expect(screen.getByTestId('tab-active-alerts')).not.toHaveClass('border-brand-500');
  });

  it('honours an explicit ?tab= over the default', () => {
    render(<Monitoring />, { wrapper: createWrapper(['/monitoring?tab=alert-history']) });
    expect(screen.getByTestId('tab-alert-history')).toHaveClass('border-brand-500');
    expect(screen.getByTestId('tab-slos')).not.toHaveClass('border-brand-500');
  });

  it('renders Active Alerts from the evaluator, not the audit log', () => {
    render(<Monitoring />, { wrapper: createWrapper(['/monitoring?tab=active-alerts']) });
    expect(screen.getByTestId('tab-active-alerts')).toHaveClass('border-brand-500');
    expect(screen.getByTestId('alert-row-api-error-rate')).toBeInTheDocument();
    expect(screen.getByTestId('alert-row-disk-pressure')).toBeInTheDocument();
    // Audit activity must not appear here at all — that is the whole point.
    expect(screen.queryByText('create tenant')).not.toBeInTheDocument();
  });

  it('keeps audit activity on its own tab', () => {
    render(<Monitoring />, { wrapper: createWrapper(['/monitoring?tab=activity']) });
    expect(screen.getByText('create tenant')).toBeInTheDocument();
    expect(screen.getByText('update domain')).toBeInTheDocument();
  });

  it('renders the expected tab buttons (system-metrics replaced by health)', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-active-alerts')).toBeInTheDocument();
    expect(screen.getByTestId('tab-alert-history')).toBeInTheDocument();
    expect(screen.getByTestId('tab-health')).toBeInTheDocument();
    // system-metrics tab removed Wave 2 — placeholder gauges retired.
    expect(screen.queryByTestId('tab-system-metrics')).not.toBeInTheDocument();
  });

  it('switches to Alert History tab on click', async () => {
    const user = userEvent.setup();
    render(<Monitoring />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('tab-alert-history'));

    expect(screen.getByTestId('tab-alert-history')).toHaveClass('border-brand-500');
    // Resolved RULES, not old audit rows.
    expect(screen.getByTestId('alert-row-cert-expiry')).toBeInTheDocument();
  });

  it('shows only non-firing rules under Alert History', async () => {
    const user = userEvent.setup();
    render(<Monitoring />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('tab-alert-history'));

    expect(screen.getByTestId('alert-row-cert-expiry')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-row-api-error-rate')).not.toBeInTheDocument();
  });

  it('switches to Health tab and renders the health panel', async () => {
    const user = userEvent.setup();
    render(<Monitoring />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('tab-health'));

    expect(screen.getByTestId('health-tab')).toBeInTheDocument();
  });

  // Severity now comes from the RULE, not from an HTTP status. Deriving it from
  // status is what made a 401 on /api/v1/auth/refresh — an expired token, i.e.
  // the refresh flow working exactly as designed — render as a platform warning.
  it('takes severity from the rule, not from an HTTP status', () => {
    render(<Monitoring />, { wrapper: createWrapper(['/monitoring?tab=active-alerts']) });
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
    // 'info' was an artefact of bucketing 2xx/3xx audit rows; a rule is only
    // ever warning or critical.
    expect(screen.queryByText('info')).not.toBeInTheDocument();
  });
});
