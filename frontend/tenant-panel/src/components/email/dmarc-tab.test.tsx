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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  relayCopies: { messages: 0, sources: 0 },
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

  it('says which failing servers are relays the recommendation does not count', async () => {
    renderTab({
      overview: {
        windowDays: 30,
        domains: [summary({ failingSources: 2, relayCopies: { messages: 32, sources: 1 } })],
        intakeLocalPart: 'postmaster',
      },
    });
    const note = await screen.findByTestId('dmarc-tenant-relays');
    expect(note).toHaveTextContent('1 of the servers is a relay');
    expect(note).toHaveTextContent('32 copies are not counted');
  });

  it('says nothing about relays when there are none', async () => {
    renderTab();
    await screen.findByTestId('dmarc-tenant-failing');
    expect(screen.queryByTestId('dmarc-tenant-relays')).toBeNull();
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

describe('DmarcTab (tenant) — the policy switch', () => {
  function renderWith(over: Record<string, unknown>, sources: readonly Record<string, unknown>[] = []) {
    apiFetch.mockImplementation((url?: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}') as { domain: string; policy: string };
        return Promise.resolve({ data: { domain: body.domain, policy: body.policy, recordName: `_dmarc.${body.domain}`, recordValue: `v=DMARC1; p=${body.policy}`, published: true } });
      }
      if (typeof url === 'string' && url.includes('/dmarc/sources')) return Promise.resolve({ data: { sources } });
      return Promise.resolve({ data: { windowDays: 30, domains: [summary(over)], intakeLocalPart: 'postmaster' } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <DmarcTab tenantId="t-1" domainName="alpha.test" />
      </QueryClientProvider>,
    );
  }
  const posted = () => {
    const post = apiFetch.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
    return post ? { url: post[0], body: JSON.parse((post[1] as { body: string }).body) as Record<string, unknown> } : null;
  };
  const notReady = {
    policyDomain: 'alpha.test', currentPolicy: 'none', recommendedPolicy: null, passRate: 0.931,
    reason: '93.1% of messages pass DMARC — below the 99.0% needed for p=quarantine.', ready: false,
  };

  it('shows NONE, QUARANTINE and REJECT, with the published one selected', async () => {
    renderWith({ managedPolicy: 'quarantine', managedRecordCount: 1 });
    const sw = await screen.findByTestId('dmarc-policy-switch-alpha.test');
    expect(sw).toHaveTextContent('NONE');
    expect(sw).toHaveTextContent('QUARANTINE');
    expect(sw).toHaveTextContent('REJECT');
    expect(screen.getByTestId('dmarc-policy-option-alpha.test-quarantine')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('dmarc-policy-option-alpha.test-none')).toHaveAttribute('aria-checked', 'false');
    for (const p of ['none', 'quarantine', 'reject']) {
      expect(screen.getByTestId(`dmarc-policy-option-alpha.test-${p}`).getAttribute('title')).toMatch(/^p=/);
    }
  });

  // The reported bug: p=none with reports that do not back a tightening had
  // neither "apply" nor "step back", so nothing rendered at all.
  it('is there at p=none while the recommendation is not ready', async () => {
    renderWith({ managedPolicy: 'none', managedRecordCount: 1, currentPolicy: 'none', passRate: 0.931, failingSources: 2, recommendation: notReady });
    const opt = await screen.findByTestId('dmarc-policy-option-alpha.test-quarantine');
    expect(opt).toBeEnabled();
    expect(screen.getByTestId('dmarc-policy-option-alpha.test-reject')).toBeEnabled();
  });

  it('a tightening the reports do not back shows their reason and is sent acknowledged', async () => {
    renderWith({ managedPolicy: 'none', managedRecordCount: 1, currentPolicy: 'none', recommendation: notReady });
    fireEvent.click(await screen.findByTestId('dmarc-policy-option-alpha.test-reject'));
    expect(screen.getByTestId('dmarc-not-backed-alpha.test')).toHaveTextContent('93.1%');
    expect(screen.getByTestId('dmarc-confirm-alpha.test')).toHaveTextContent('Publish p=reject anyway');
    fireEvent.click(screen.getByTestId('dmarc-confirm-alpha.test'));
    await waitFor(() => expect(posted()?.body).toEqual({ domain: 'alpha.test', policy: 'reject', acknowledgeNotRecommended: true }));
    expect(posted()?.url).toBe('/api/v1/tenants/t-1/mail/dmarc/policy');
    expect(await screen.findByTestId('dmarc-applied-alpha.test')).toHaveTextContent('p=reject is published');
  });

  it('marks the recommended step, and sends it without an acknowledgement', async () => {
    renderWith({ managedPolicy: 'quarantine', managedRecordCount: 1 });
    expect(await screen.findByTestId('dmarc-recommended-alpha.test')).toHaveTextContent('REJECT');
    fireEvent.click(screen.getByTestId('dmarc-policy-option-alpha.test-reject'));
    expect(screen.queryByTestId('dmarc-not-backed-alpha.test')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dmarc-confirm-alpha.test'));
    await waitFor(() => expect(posted()?.body).toEqual({ domain: 'alpha.test', policy: 'reject' }));
  });

  it('loosens without an acknowledgement', async () => {
    renderWith({ managedPolicy: 'quarantine', managedRecordCount: 1 });
    fireEvent.click(await screen.findByTestId('dmarc-policy-option-alpha.test-none'));
    expect(screen.queryByTestId('dmarc-not-backed-alpha.test')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dmarc-confirm-alpha.test'));
    await waitFor(() => expect(posted()?.body).toEqual({ domain: 'alpha.test', policy: 'none' }));
  });

  it('does not re-offer a step that is published while the reports catch up', async () => {
    renderWith({
      managedPolicy: 'quarantine',
      currentPolicy: 'none',
      recommendation: { policyDomain: 'alpha.test', currentPolicy: 'none', recommendedPolicy: 'quarantine', passRate: 1, reason: 'safe', ready: true },
    });
    expect(await screen.findByTestId('dmarc-lagging-alpha.test')).toBeInTheDocument();
    expect(screen.getByTestId('dmarc-policy-option-alpha.test-quarantine')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('dmarc-recommended-alpha.test')).not.toBeInTheDocument();
  });

  it('is shown but disabled for a duplicate _dmarc record, which it names', async () => {
    renderWith({ managedPolicy: null, managedRecordCount: 2 });
    expect(await screen.findByTestId('dmarc-duplicate-alpha.test')).toHaveTextContent('Re-create mail records');
    expect(screen.queryByTestId('dmarc-unmanaged-alpha.test')).not.toBeInTheDocument();
    expect(screen.getByTestId('dmarc-policy-option-alpha.test-reject')).toBeDisabled();
  });

  it('is shown but disabled when the platform does not manage the record', async () => {
    renderWith({ managedPolicy: null });
    expect(await screen.findByTestId('dmarc-unmanaged-alpha.test')).toBeInTheDocument();
    expect(screen.getByTestId('dmarc-policy-option-alpha.test-none')).toBeDisabled();
  });

  // A new domain starts at p=quarantine; its first report arrives a day or two
  // after its first mail. The way back must be there before that.
  it('offers the step back before the first report', async () => {
    renderWith({
      reportCount: 0, totalMessages: 0, passMessages: 0, passRate: null, currentPolicy: null,
      firstReportAt: null, lastReportAt: null, windowDays: 0,
      managedPolicy: 'quarantine', managedRecordCount: 1,
      recommendation: { policyDomain: 'alpha.test', currentPolicy: null, recommendedPolicy: null, passRate: null, reason: 'No DMARC reports received yet for this domain — nothing to judge a policy change on.', ready: false },
    });
    expect(await screen.findByTestId('dmarc-tenant-empty')).toBeInTheDocument();
    expect(screen.getByTestId('dmarc-tenant-policy')).toHaveTextContent('Quarantine failures');
    expect(screen.queryByTestId('dmarc-tenant-pass-rate')).not.toBeInTheDocument();
    // Said once, in the box above, not again under the policy.
    expect(screen.queryByTestId('dmarc-tenant-recommendation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dmarc-policy-option-alpha.test-none'));
    fireEvent.click(screen.getByTestId('dmarc-confirm-alpha.test'));
    await waitFor(() => expect(posted()?.body).toEqual({ domain: 'alpha.test', policy: 'none' }));
  });

  it('badges each source and gives every badge a tooltip; shows reverse DNS under the address', async () => {
    renderWith({ managedPolicy: 'none', managedRecordCount: 1 }, [
      { sourceIp: '192.0.2.10', policyDomain: 'alpha.test', messageCount: 346, passCount: 346, failCount: 0, lastSeenAt: '2026-09-15T00:00:00Z',
        reverseDns: 'mail.example.test', reverseDnsStatus: 'found', isCluster: true, inSpf: true, relayedCount: 346, isRelay: false },
      { sourceIp: '198.51.100.7', policyDomain: 'alpha.test', messageCount: 32, passCount: 8, failCount: 24, lastSeenAt: '2026-09-15T00:00:00Z',
        reverseDns: 'scanner.example.net', reverseDnsStatus: 'found', isCluster: false, inSpf: false, relayedCount: 32, isRelay: true },
      { sourceIp: '203.0.113.9', policyDomain: 'alpha.test', messageCount: 5, passCount: 0, failCount: 5, lastSeenAt: '2026-09-15T00:00:00Z',
        reverseDns: null, reverseDnsStatus: 'none', isCluster: null, inSpf: null, relayedCount: 0, isRelay: false },
    ]);
    const ours = await screen.findByTestId('dmarc-badge-cluster-192.0.2.10');
    expect(ours.getAttribute('title')).toMatch(/platform's servers/);
    expect(screen.getByTestId('dmarc-badge-spf-192.0.2.10').getAttribute('title')).toMatch(/SPF record/);
    expect(screen.queryByTestId('dmarc-badge-relay-192.0.2.10')).not.toBeInTheDocument();
    expect(screen.getByTestId('dmarc-ptr-192.0.2.10')).toHaveTextContent('mail.example.test');

    expect(screen.getByTestId('dmarc-badge-relay-198.51.100.7').getAttribute('title')).toMatch(/forwarder or the recipient/);
    expect(screen.queryByTestId('dmarc-badge-cluster-198.51.100.7')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dmarc-badge-spf-198.51.100.7')).not.toBeInTheDocument();

    // Unknown is shown as nothing, never as "no".
    for (const b of ['cluster', 'spf', 'relay']) {
      expect(screen.queryByTestId(`dmarc-badge-${b}-203.0.113.9`)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId('dmarc-ptr-203.0.113.9')).toHaveTextContent('no reverse DNS');
  });
});
