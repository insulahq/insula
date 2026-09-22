import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantDashboardSummary, TenantDashboardLive } from '@insula/api-contracts';
import Dashboard from '../pages/Dashboard';

/**
 * The tenant overview's load-bearing behaviours.
 *
 * The one worth stating: `reserved` is shown separately from `in use`,
 * because reserved is the figure that refuses the next deployment while
 * usage says there is plenty of room — the shape of the 1Gi tenant that
 * could not fit a 512Mi app.
 */

const { summaryFn, liveFn } = vi.hoisted(() => ({ summaryFn: vi.fn(), liveFn: vi.fn() }));
vi.mock('@/hooks/use-hosting-overview', () => ({
  useOverviewSummary: () => summaryFn(),
  useOverviewLive: () => liveFn(),
}));
vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: () => ({ tenantId: 't1' }),
}));

const ok = <T,>(data: T) => ({ state: 'ok' as const, reason: null, observedAt: null, data });

function summary(over: Partial<TenantDashboardSummary> = {}): TenantDashboardSummary {
  return {
    generatedAt: new Date().toISOString(),
    alerts: ok([]),
    plan: ok({ name: 'Ultimate', bandwidthUsedGb: 16, bandwidthLimitGb: 100, bandwidthResetDays: 9, bandwidthCapped: false }),
    mail: ok({ mailboxes: 6, maxMailboxes: 10, storageUsedGb: 11.4, storageLimitGb: 50, fullestMailboxPct: 42, fullestMailboxAddress: 'sales@example.test', sentToday: 38, dailyLimit: 100 }),
    domains: ok({ domains: 3, verified: 3, certificates: 4, nearestRenewalDays: 74 }),
    backups: ok({ restorePoints: 31, newestAt: new Date().toISOString(), oldestAt: new Date().toISOString(), coversFiles: true, coversDatabases: true }),
    scheduledTasks: ok({ total: 3, enabled: 2, failed24h: 0, nextRunAt: null }),
    recentChanges: ok([]),
    ...over,
  } as TenantDashboardSummary;
}

function live(over: Partial<TenantDashboardLive> = {}): TenantDashboardLive {
  return {
    generatedAt: new Date().toISOString(),
    resources: ok({
      cpu: { inUse: 0.02, committed: 0.5, total: 2, unit: 'cores', kind: 'reserve' as const },
      memory: { inUse: 0.39, committed: 1.5, total: 2, unit: 'GiB', kind: 'reserve' as const },
      storage: { inUse: 6, committed: 6, total: 10, unit: 'GiB', kind: 'consume' as const },
    }),
    sites: ok([]),
    blocked: ok([]),
    ...over,
  } as TenantDashboardLive;
}

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><Dashboard /></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  summaryFn.mockReturnValue({ data: { data: summary() }, isLoading: false });
  liveFn.mockReturnValue({ data: { data: live() }, isLoading: false });
});

describe('Hosting overview — conditional alerts', () => {
  it('shows no alert chips when nothing needs the customer', () => {
    show();
    expect(screen.queryAllByTestId('alert-chip')).toHaveLength(0);
    expect(screen.getByText(/nothing needs you/i)).toBeInTheDocument();
  });

  it('shows a chip when something does', () => {
    summaryFn.mockReturnValue({
      data: { data: summary({ alerts: ok([{
        categoryId: 'mailbox.quota_threshold', severity: 'critical' as const, value: '94%',
        title: 'A mailbox is nearly full', subtitle: 'sales@example.test', href: '/email',
        detail: [['Used', '4.7 of 5 GB']], note: null,
      }]) }) }, isLoading: false,
    });
    show();
    expect(screen.getAllByTestId('alert-chip')).toHaveLength(1);
    expect(screen.getAllByText('A mailbox is nearly full').length).toBeGreaterThan(0);
  });
});

describe('Hosting overview — plan', () => {
  it('shows in use and reserved as different figures', () => {
    show();
    // 0.02 in use against 0.50 reserved of 2.00 — the gap is the point.
    expect(screen.getByText('0.02')).toBeInTheDocument();
    expect(screen.getByText(/reserved 25%/)).toBeInTheDocument();
  });

  it('warns when little is left to reserve, and says what that means', () => {
    show();
    // Memory: 1.5 of 2 reserved = 75%, which is the tight threshold.
    expect(screen.getByText(/has to fit in that, not in what is idle/i)).toBeInTheDocument();
  });

  it('treats storage as consumed, not reserved — no reserved band', () => {
    show();
    // A "reserved" legend for storage would claim the full limit is free
    // while 6 GiB sits on disk.
    expect(screen.queryByText(/reserved 60%/)).not.toBeInTheDocument();
    expect(screen.getByText(/free 4/)).toBeInTheDocument();
  });

  it('shows bandwidth against the allowance', () => {
    show();
    expect(screen.getByText('16.0')).toBeInTheDocument();
    expect(screen.getByText(/resets in 9 days/i)).toBeInTheDocument();
  });
});

describe('Hosting overview — mail', () => {
  it('shows the fullest mailbox, which is what refuses mail', () => {
    show();
    // The COUNT against the plan is not an alert; per-mailbox storage is.
    expect(screen.getAllByText('Fullest mailbox').length).toBeGreaterThan(0);
    expect(screen.getAllByText('42%').length).toBeGreaterThan(0);
  });
});

describe('Hosting overview — degraded sections', () => {
  it('a failed section says so rather than rendering blank', () => {
    liveFn.mockReturnValue({
      data: { data: live({
        resources: { state: 'failed', reason: 'metrics did not answer within 4000ms', observedAt: null, data: null },
      }) }, isLoading: false,
    });
    show();
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/metrics did not answer/i)).toBeInTheDocument();
  });
});
