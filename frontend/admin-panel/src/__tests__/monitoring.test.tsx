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

vi.mock('@/hooks/use-pods', () => ({
  usePods: () => ({
    data: { data: { pods: [], capacity: { used: 5, allocatable: 110 } } },
    isLoading: false,
    isError: false,
  }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
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

  it('shows Active Alerts count from audit log data', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    // 3 recent entries (within 24h), 1 old entry
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders Active Alerts tab by default with audit log data', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-active-alerts')).toHaveClass('border-brand-500');
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
    expect(screen.getByText('create region')).toBeInTheDocument();
  });

  it('shows Resolved badges in Alert History tab', async () => {
    const user = userEvent.setup();
    render(<Monitoring />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('tab-alert-history'));

    const resolvedBadges = screen.getAllByText('Resolved');
    expect(resolvedBadges.length).toBeGreaterThan(0);
  });

  it('switches to Health tab and renders the health panel', async () => {
    const user = userEvent.setup();
    render(<Monitoring />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('tab-health'));

    expect(screen.getByTestId('health-tab')).toBeInTheDocument();
  });

  it('displays alert severity badges derived from httpStatus', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    // httpStatus 201 -> info, 500 -> critical, 404 -> warning
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
    expect(screen.getByText('info')).toBeInTheDocument();
  });
});
