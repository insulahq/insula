/**
 * DMARC section (ROADMAP R5).
 *
 * Two behaviours are worth pinning, and both are about NOT over-claiming:
 *   - "no reports" must not read as "everything passes". The platform was in
 *     exactly that state before R5 — the published rua= pointed at a mailbox
 *     that never existed, so no report could ever arrive, and nothing said so.
 *   - a pass rate with no denominator must render as "no data", never as 0%
 *     (catastrophe) or 100% (all clear).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: vi.mock is hoisted above the module body, so a plain `const`
// declared here is not yet initialised when the factory runs.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: DmarcSection } = await import('./DmarcSection');

const domain = (over: Record<string, unknown> = {}) => ({
  policyDomain: 'example.test',
  tenantId: 't-1',
  reportCount: 12,
  totalMessages: 5000,
  passMessages: 5000,
  failMessages: 0,
  dkimPassMessages: 5000,
  spfPassMessages: 4900,
  quarantinedMessages: 0,
  rejectedMessages: 0,
  passRate: 1,
  currentPolicy: 'none',
  firstReportAt: '2026-08-14T00:00:00Z',
  lastReportAt: '2026-09-13T00:00:00Z',
  windowDays: 30,
  failingSources: 0,
  recommendation: {
    policyDomain: 'example.test',
    currentPolicy: 'none',
    recommendedPolicy: 'quarantine',
    passRate: 1,
    reason: '100.0% of 5000 message(s) passed over 30 days with no failing sources — safe to move to p=quarantine.',
    ready: true,
  },
  ...over,
});

function renderWith(overview: Record<string, unknown>, sources: readonly Record<string, unknown>[] = []) {
  apiFetch.mockImplementation((url?: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { domain: string; policy: string };
      return Promise.resolve({ data: { domain: body.domain, policy: body.policy, recordName: `_dmarc.${body.domain}`, recordValue: `v=DMARC1; p=${body.policy}`, published: true } });
    }
    if (typeof url === 'string' && url.includes('/dmarc/sources')) return Promise.resolve({ data: sources });
    return Promise.resolve({ data: overview });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><DmarcSection /></QueryClientProvider>);
}

beforeEach(() => apiFetch.mockReset());

describe('DmarcSection', () => {
  it('says "no reports" is not the same as "everything passes"', async () => {
    renderWith({ windowDays: 30, domains: [], intakeLocalPart: 'dmarc' });
    const empty = await screen.findByTestId('dmarc-empty');
    expect(empty.textContent).toContain('not the same as');
    // And it names the address reports must reach, so a non-delivering rua=
    // is diagnosable from this screen.
    expect(empty.textContent).toContain('dmarc@');
  });

  it('renders a pass rate with its denominator', async () => {
    renderWith({ windowDays: 30, domains: [domain()], intakeLocalPart: 'dmarc' });
    await screen.findByTestId('dmarc-domains');
    expect(screen.getByText('100.0%')).toBeTruthy();
    expect(screen.getByText(/of 5,000/)).toBeTruthy();
  });

  it('renders a null pass rate as "no data", not as 0% or 100%', async () => {
    renderWith({
      windowDays: 30,
      domains: [domain({ passRate: null, totalMessages: 0, passMessages: 0, reportCount: 0 })],
      intakeLocalPart: 'dmarc',
    });
    await screen.findByTestId('dmarc-domains');
    expect(screen.getByText('no data')).toBeTruthy();
    expect(screen.queryByText('0.0%')).toBeNull();
    expect(screen.queryByText('100.0%')).toBeNull();
  });

  it('shows the tightening hint only when the recommendation is ready', async () => {
    renderWith({ windowDays: 30, domains: [domain()], intakeLocalPart: 'dmarc' });
    await screen.findByTestId('dmarc-domains');
    expect(screen.getByText(/move to p=quarantine/)).toBeTruthy();
  });

  it('says "keep observing" when a recommendation is not ready', async () => {
    // Gated on `ready`, not on recommendedPolicy != null, so an unknown can
    // never render as a green go-ahead.
    renderWith({
      windowDays: 30,
      domains: [domain({
        failingSources: 2,
        recommendation: {
          policyDomain: 'example.test', currentPolicy: 'none', recommendedPolicy: null,
          passRate: 0.999, reason: '99.9% passing, but 2 source(s) are still failing.', ready: false,
        },
      })],
      intakeLocalPart: 'dmarc',
    });
    await screen.findByTestId('dmarc-domains');
    expect(screen.getByText(/keep observing/)).toBeTruthy();
    expect(screen.queryByText(/move to p=/)).toBeNull();
  });

  it('surfaces failing sources as a count an operator can act on', async () => {
    renderWith({ windowDays: 30, domains: [domain({ failingSources: 3 })], intakeLocalPart: 'dmarc' });
    await screen.findByTestId('dmarc-domains');
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('shows the policy switch in the expanded row even when nothing is recommended, and badges the sources', async () => {
    renderWith({
      windowDays: 30,
      domains: [domain({
        managedPolicy: 'none', managedRecordCount: 1, failingSources: 2,
        recommendation: {
          policyDomain: 'example.test', currentPolicy: 'none', recommendedPolicy: null,
          passRate: 0.931, reason: '93.1% of messages pass DMARC.', ready: false,
        },
      })],
      intakeLocalPart: 'dmarc',
    }, [
      { sourceIp: '198.51.100.7', policyDomain: 'example.test', messageCount: 32, passCount: 8, failCount: 24, lastSeenAt: '2026-09-15T00:00:00Z',
        reverseDns: 'scanner.example.net', reverseDnsStatus: 'found', isCluster: false, inSpf: false, relayedCount: 32, isRelay: true },
    ]);
    fireEvent.click(await screen.findByText('example.test'));
    fireEvent.click(await screen.findByTestId('dmarc-policy-option-example.test-quarantine'));
    expect(screen.getByTestId('dmarc-not-backed-example.test')).toHaveTextContent('93.1%');
    fireEvent.click(screen.getByTestId('dmarc-confirm-example.test'));
    await waitFor(() => {
      const post = apiFetch.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
      expect(post?.[0]).toBe('/api/v1/admin/mail/dmarc/policy');
      expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({ domain: 'example.test', policy: 'quarantine', acknowledgeNotRecommended: true });
    });
    expect((await screen.findByTestId('dmarc-badge-relay-198.51.100.7')).getAttribute('title')).toMatch(/recipient/);
    expect(screen.getByTestId('dmarc-ptr-198.51.100.7')).toHaveTextContent('scanner.example.net');
  });
});
