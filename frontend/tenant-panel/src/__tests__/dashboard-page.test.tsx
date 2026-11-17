import { render, screen, fireEvent } from '@testing-library/react';
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
const { subscriptionFn } = vi.hoisted(() => ({ subscriptionFn: vi.fn() }));
vi.mock('@/hooks/use-subscription', () => ({
  useSubscription: () => subscriptionFn(),
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
  subscriptionFn.mockReturnValue({ data: undefined });
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
    // 0.02 in use against 0.50 reserved of 2.00. The tile prints cores at
    // ONE decimal by operator decision, so the in-use figure rounds to
    // "0.0"; the reserved share is what carries the distinction here.
    expect(screen.getByText((_t, el) => el?.textContent === '0.0/2.0')).toBeInTheDocument();
    expect(screen.getByText(/reserved 25%/)).toBeInTheDocument();
  });

  /**
   * The bug this pins: the tile inferred "usage unavailable" from
   * `inUse === 0 && committed > 0`. Measured on production, 23 of 27 tenants
   * hit that — metrics-server was answering for every one of them, and they
   * were simply using less than a millicore. Only a null means unmeasured now.
   */
  it('shows a measured ZERO as zero, not as unavailable', () => {
    liveFn.mockReturnValue({
      data: { data: live({ resources: ok({
        cpu: { inUse: 0, committed: 0.5, total: 2, unit: 'cores', kind: 'reserve' as const },
        memory: { inUse: 0.4, committed: 1.5, total: 2, unit: 'GiB', kind: 'reserve' as const },
        storage: { inUse: 1, committed: 1, total: 10, unit: 'GiB', kind: 'consume' as const },
      }) }) }, isLoading: false,
    });
    show();
    expect(screen.getByText((_t, el) => el?.textContent === '0.0/2.0')).toBeInTheDocument();
    expect(screen.queryByText(/usage unavailable/)).not.toBeInTheDocument();
  });

  it('says unavailable only when the metrics API did not answer', () => {
    liveFn.mockReturnValue({
      data: { data: live({ resources: ok({
        cpu: { inUse: null, committed: 0.5, total: 2, unit: 'cores', kind: 'reserve' as const },
        memory: { inUse: null, committed: 1.5, total: 2, unit: 'GiB', kind: 'reserve' as const },
        storage: { inUse: 1, committed: 1, total: 10, unit: 'GiB', kind: 'consume' as const },
      }) }) }, isLoading: false,
    });
    show();
    expect(screen.getAllByText(/usage unavailable/).length).toBeGreaterThan(0);
  });

  /**
   * This used to pin "a sub-millicore reading stays visible" — 0.019 printed
   * as 0.019. Cores are shown at one decimal now, by operator decision, so
   * that property is gone deliberately and asserting it would be asserting
   * the old design. What still matters, and what this pins, is that a small
   * non-zero reading is not reported as UNAVAILABLE: rounding it for display
   * is a choice, claiming it was never measured is a lie.
   */
  it('a sub-decimal reading is rounded, never reported as unmeasured', () => {
    // The real production shape: three containers totalling 0.019 cores.
    liveFn.mockReturnValue({
      data: { data: live({ resources: ok({
        cpu: { inUse: 0.019, committed: 0.75, total: 2, unit: 'cores', kind: 'reserve' as const },
        memory: { inUse: 0.4, committed: 1.5, total: 2, unit: 'GiB', kind: 'reserve' as const },
        storage: { inUse: 1, committed: 1, total: 10, unit: 'GiB', kind: 'consume' as const },
      }) }) }, isLoading: false,
    });
    show();
    expect(screen.getByText((_t, el) => el?.textContent === '0.0/2.0')).toBeInTheDocument();
    expect(screen.queryByText(/usage unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not reported/)).not.toBeInTheDocument();
  });

  it('flags a tight plan on the headline rather than in a sentence below', () => {
    show();
    // Memory: 1.5 of 2 reserved = 75%, the tight threshold. The explanatory
    // paragraph was removed on operator feedback; the remaining free figure
    // carries the warning colour instead.
    const free = screen.getByText('0.5 free');
    expect(free).toBeInTheDocument();
    expect(free.className).toMatch(/amber/);
    expect(screen.queryByText(/has to fit in that, not in what is idle/i)).toBeNull();
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


/** Same chrome pass as the operator console — see that file for the reasoning. */
describe('Hosting overview — chrome', () => {
  it('gives headings a name and nothing else', () => {
    show();
    expect(screen.getByText('Your plan')).toBeInTheDocument();
    expect(screen.queryByText(/in use · reserved by your apps · free/)).not.toBeInTheDocument();
  });

  it('draws no rule beside or under a heading', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><Dashboard /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container.querySelector('.h-px.flex-1')).toBeNull();
    expect(container.querySelector('header')!.className).not.toMatch(/border-b/);
  });

  it('refreshes both polls on demand, in line with the title', () => {
    const summaryRefetch = vi.fn();
    const liveRefetch = vi.fn();
    summaryFn.mockReturnValue({ data: { data: summary() }, isLoading: false, isFetching: false, refetch: summaryRefetch });
    liveFn.mockReturnValue({ data: { data: live() }, isLoading: false, isFetching: false, refetch: liveRefetch });
    show();
    const btn = screen.getByTestId('dashboard-refresh');
    expect(btn.closest('header')).not.toBeNull();
    fireEvent.click(btn);
    expect(summaryRefetch).toHaveBeenCalledTimes(1);
    expect(liveRefetch).toHaveBeenCalledTimes(1);
  });
});

describe('Hosting overview — renewal date', () => {
  it('shows when the plan renews, under the plan name', () => {
    subscriptionFn.mockReturnValue({ data: { data: { subscription_expires_at: '2026-11-30T12:00:00Z' } } });
    show();
    const renewal = screen.getByTestId('dashboard-renewal');
    expect(renewal).toHaveTextContent(/^Next renewal date: /);
    expect(renewal).toHaveTextContent('2026');
    expect(renewal.previousElementSibling).toHaveTextContent('Ultimate plan');
  });

  it('shows none for a plan that never expires', () => {
    subscriptionFn.mockReturnValue({ data: { data: { subscription_expires_at: null } } });
    show();
    expect(screen.queryByTestId('dashboard-renewal')).not.toBeInTheDocument();
  });
});

/**
 * "Renews in" read "0d" for weeks: a deleted domain's certificate row, whose
 * renewal point never moved, held the minimum at 0. With those rows gone, 0
 * means the renewal is due now, and the tile says so.
 */
describe('Domains & certificates — when the earliest certificate renews', () => {
  const renewal = (nearestRenewalDays: number | null) => summaryFn.mockReturnValue({
    data: { data: summary({ domains: ok({ domains: 3, verified: 3, certificates: 4, nearestRenewalDays }) }) },
    isLoading: false,
  });

  it('days ahead read as days', () => {
    renewal(74);
    show();
    expect(screen.getByText('74d')).toBeInTheDocument();
    expect(screen.getByText('74 days')).toBeInTheDocument();
  });

  it('0 reads as due now, not "0d"', () => {
    renewal(0);
    show();
    expect(screen.getByText('now')).toBeInTheDocument();
    expect(screen.getByText('due now')).toBeInTheDocument();
    expect(screen.queryByText('0d')).not.toBeInTheDocument();
  });
});

/**
 * The sending-limit warning card. It exists because a tenant at its limit was
 * told "limit exceeded" and saw nothing about what had happened to the mail:
 * it names each domain, says how much is held back and until when and how much
 * was refused, explains on hover that held mail is not lost, and opens Email →
 * Statistics with that domain picked.
 */
describe('Hosting overview — sending limit card', () => {
  const throttle = {
    domain: 'shop.example.test', emailDomainId: 'ed-1', window: 'day' as const, heldNow: 9,
    releasesAt: '2026-11-17T00:00:00.000Z', heldToday: 9, refusedToday: 2, refusing: false,
    sentThisHour: 10, sentToday: 101,
  };
  const mail = (throttles: unknown[]) => ok({
    mailboxes: 6, maxMailboxes: 10, storageUsedGb: 11.4, storageLimitGb: 50, fullestMailboxPct: 42,
    fullestMailboxAddress: 'sales@example.test', sentToday: 101, dailyLimit: 100, hourlyLimit: 50,
    sentTodayDomain: 'shop.example.test', outboundSuspended: false, throttles,
  });

  it('is absent while no limit is holding mail', () => {
    summaryFn.mockReturnValue({ data: { data: summary({ mail: mail([]) } as Partial<TenantDashboardSummary>) }, isLoading: false });
    show();
    expect(screen.queryByTestId('mail-throttle-card')).toBeNull();
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
  });

  it('names the domain, what is held back and refused, and links to its statistics', () => {
    summaryFn.mockReturnValue({ data: { data: summary({ mail: mail([throttle]) } as Partial<TenantDashboardSummary>) }, isLoading: false });
    show();
    const card = screen.getByTestId('mail-throttle-card');
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull();
    const row = screen.getByTestId('mail-throttle-shop.example.test');
    expect(row.getAttribute('href')).toBe('/email/statistics?emailDomain=ed-1');
    expect(row.textContent).toContain('9 messages held back until');
    expect(row.textContent).toContain('2 refused today');
    expect(row.textContent).toContain('101 of 100 today');
    // The hover card answers "is my mail lost?".
    expect(card.textContent).toContain('How sending limits work');
    expect(card.textContent).toContain('Mail over a limit is not lost');
    expect(card.textContent).toContain('new messages are refused with a temporary error');
  });

  it('lists every affected domain, one link each; a relay-only domain opens the tab without a pick', () => {
    const relay = { ...throttle, domain: 'relay.example.test', emailDomainId: null, heldNow: 0, window: null, releasesAt: null, refusing: true };
    summaryFn.mockReturnValue({ data: { data: summary({ mail: mail([throttle, relay]) } as Partial<TenantDashboardSummary>) }, isLoading: false });
    show();
    expect(screen.getByTestId('mail-throttle-relay.example.test').getAttribute('href')).toBe('/email/statistics');
    expect(screen.getByTestId('mail-throttle-relay.example.test').textContent).toContain('new mail refused while the queue is full');
  });
});
