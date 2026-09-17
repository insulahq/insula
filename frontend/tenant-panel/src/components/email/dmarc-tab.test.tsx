/**
 * The tenant-facing DMARC tab.
 *
 * The failure mode this surface must not have is over-claiming. Three states
 * look identical if you are careless, and each means something different:
 *
 *   - no reports yet          → unknown
 *   - reports, all passing    → good
 *   - request failed          → unknown, and something is broken
 *
 * Rendering the third as an empty table tells the domain owner "nobody is
 * sending as you", which is the one answer this page must never invent.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: DmarcTab } = await import('./DmarcTab');

const summary = (over: Record<string, unknown> = {}) => ({
  policyDomain: 'alpha.test',
  tenantId: 't-1',
  reportCount: 8,
  totalMessages: 4200,
  passMessages: 4200,
  failMessages: 0,
  dkimPassMessages: 4200,
  spfPassMessages: 4100,
  quarantinedMessages: 0,
  rejectedMessages: 0,
  passRate: 1,
  currentPolicy: 'quarantine',
  firstReportAt: '2026-08-18T00:00:00Z',
  lastReportAt: '2026-09-16T00:00:00Z',
  windowDays: 29,
  failingSources: 0,
  recommendation: {
    policyDomain: 'alpha.test',
    currentPolicy: 'quarantine',
    recommendedPolicy: 'reject',
    passRate: 1,
    reason: '100.0% of 4200 message(s) passed over 29 days with no failing sources.',
    ready: true,
  },
  ...over,
});

function renderTab(opts: {
  overview?: Record<string, unknown>;
  sources?: readonly Record<string, unknown>[];
  overviewFails?: boolean;
  sourcesFail?: boolean;
  domainName?: string;
} = {}) {
  const fail = () => Promise.reject(new Error('boom'));
  apiFetch.mockImplementation((url?: string) => {
    const isSources = typeof url === 'string' && url.includes('/dmarc/sources');
    if (isSources) {
      return opts.sourcesFail
        ? fail()
        : Promise.resolve({ data: { sources: opts.sources ?? [] } });
    }
    return opts.overviewFails
      ? fail()
      : Promise.resolve({
        data: opts.overview ?? { windowDays: 30, domains: [summary()], intakeLocalPart: 'postmaster' },
      });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DmarcTab tenantId="t-1" domainName={opts.domainName ?? 'alpha.test'} />
    </QueryClientProvider>,
  );
}

describe('DmarcTab (tenant)', () => {
  // `vi.resetAllMocks()`, not `apiFetch.mockReset()`. Vitest tracks a mock's
  // returned promises to decide what counts as an unhandled rejection, and
  // resetting the single mock drops that tracking — so the deliberately
  // failing query below gets reported as an unhandled rejection and fails a
  // test that is in fact asserting the right thing. Cost an hour; matches the
  // idiom already used in cert-download-section.test.tsx.
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('asks the TENANT-scoped endpoint, never the admin one', async () => {
    renderTab();
    await screen.findByTestId('dmarc-tenant-pass-rate');
    const urls = apiFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith('/api/v1/tenants/t-1/mail/dmarc'))).toBe(true);
    expect(urls.some((u) => u.includes('/admin/'))).toBe(false);
  });

  it('shows the pass rate WITH its denominator', async () => {
    renderTab();
    const rate = await screen.findByTestId('dmarc-tenant-pass-rate');
    expect(rate.textContent).toContain('100.0%');
    expect(rate.textContent).toContain('of 4,200 messages');
  });

  it('renders a missing pass rate as "not enough data", not 0% or 100%', async () => {
    renderTab({
      overview: {
        windowDays: 30,
        domains: [summary({ passRate: null, totalMessages: 0, passMessages: 0, reportCount: 1 })],
        intakeLocalPart: 'postmaster',
      },
    });
    const rate = await screen.findByTestId('dmarc-tenant-pass-rate');
    expect(rate.textContent).toContain('not enough data');
    expect(rate.textContent).not.toContain('0.0%');
    expect(rate.textContent).not.toContain('100.0%');
  });

  it('says "no reports" is not "everything passes"', async () => {
    renderTab({ overview: { windowDays: 30, domains: [], intakeLocalPart: 'postmaster' } });
    const empty = await screen.findByTestId('dmarc-tenant-empty');
    expect(empty.textContent).toContain('not the same as');
  });

  it('matches reports to the selected domain, not to the first row', async () => {
    // A tenant with several email domains gets a row per domain. Reading
    // domains[0] would show one domain's numbers under another's name.
    renderTab({
      overview: {
        windowDays: 30,
        domains: [
          summary({ policyDomain: 'beta.test', passRate: 0.5, totalMessages: 10, failingSources: 4 }),
          summary({ policyDomain: 'alpha.test' }),
        ],
        intakeLocalPart: 'postmaster',
      },
      domainName: 'alpha.test',
    });
    const rate = await screen.findByTestId('dmarc-tenant-pass-rate');
    expect(rate.textContent).toContain('of 4,200 messages');
    expect(screen.getByTestId('dmarc-tenant-failing').textContent).toContain('none');
  });

  it('matches the domain case-insensitively', async () => {
    renderTab({
      overview: {
        windowDays: 30,
        domains: [summary({ policyDomain: 'alpha.test' })],
        intakeLocalPart: 'postmaster',
      },
      domainName: 'ALPHA.test',
    });
    await screen.findByTestId('dmarc-tenant-pass-rate');
    expect(screen.queryByTestId('dmarc-tenant-empty')).toBeNull();
  });

  it('describes the published policy in words, not just as p=quarantine', async () => {
    renderTab();
    const policy = await screen.findByTestId('dmarc-tenant-policy');
    expect(policy.textContent).toContain('Quarantine failures');
  });

  it('says receivers have no instructions when no policy is published', async () => {
    renderTab({
      overview: {
        windowDays: 30,
        domains: [summary({ currentPolicy: null })],
        intakeLocalPart: 'postmaster',
      },
    });
    const policy = await screen.findByTestId('dmarc-tenant-policy');
    expect(policy.textContent).toContain('not published');
  });

  it('a failed overview reads as an error, NOT as "no reports yet"', async () => {
    renderTab({ overviewFails: true });
    const err = await screen.findByTestId('dmarc-tenant-error');
    expect(err.textContent).toContain('Could not load');
    expect(screen.queryByTestId('dmarc-tenant-empty')).toBeNull();
  });

  it('a failed source list reads as an error, NOT as "nobody sent as you"', async () => {
    renderTab({ sourcesFail: true });
    const err = await screen.findByTestId('dmarc-tenant-sources-error');
    expect(err.textContent).toContain('not an empty result');
    expect(screen.queryByTestId('dmarc-tenant-sources')).toBeNull();
  });

  it('lists the sending servers with their failure counts', async () => {
    renderTab({
      sources: [
        { sourceIp: '203.0.113.9', policyDomain: 'alpha.test', messageCount: 120, passCount: 0, failCount: 120, lastSeenAt: '2026-09-15T00:00:00Z' },
      ],
    });
    await screen.findByTestId('dmarc-tenant-sources');
    const row = screen.getByTestId('dmarc-source-203.0.113.9');
    expect(row.textContent).toContain('203.0.113.9');
    expect(row.textContent).toContain('120');
  });

  it('scopes the source query to the selected domain', async () => {
    renderTab({ domainName: 'alpha.test' });
    await screen.findByTestId('dmarc-tenant-pass-rate');
    const sourceCall = apiFetch.mock.calls.map(String).find((u) => u.includes('/dmarc/sources'));
    expect(sourceCall).toContain('domain=alpha.test');
  });
});
