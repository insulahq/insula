/**
 * TLS reports section.
 *
 * The failure modes worth pinning are all about not over-claiming:
 *   - a success rate with NO sessions must render as "no data", never 100%;
 *   - a failure count must never appear without its denominator;
 *   - an empty list must read as "not every provider reports", not "broken".
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: TlsReportsSection } = await import('./TlsReportsSection');

const report = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  policyDomain: 'tenant.test',
  tenantId: 't-1',
  tenantName: 'Tenant Ltd',
  orgName: 'Reporter Inc',
  contactInfo: 'tls@reporter.test',
  reportId: 'rep-1',
  dateRangeStart: '2026-09-17T00:00:00Z',
  dateRangeEnd: '2026-09-18T00:00:00Z',
  successfulSessions: 480,
  failedSessions: 3,
  failures: [{
    resultType: 'certificate-expired',
    failedSessionCount: 3,
    receivingMxHostname: 'mx.tenant.test',
    sendingMtaIp: '198.51.100.7',
    failureReasonCode: null,
    additionalInformation: null,
  }],
  receivedAt: '2026-09-18T06:00:00Z',
  ...over,
});

function renderSection(over: Record<string, unknown> = {}) {
  apiFetch.mockResolvedValue({
    data: {
      windowDays: 30,
      reports: [report()],
      total: 1,
      totalSuccessfulSessions: 480,
      totalFailedSessions: 3,
      successRate: 480 / 483,
      intakeLocalPart: 'postmaster',
      ...over,
    },
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TlsReportsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => { apiFetch.mockReset(); });

describe('TlsReportsSection', () => {
  it('shows the failure count WITH its denominator', async () => {
    renderSection();
    const totals = await screen.findByTestId('tls-totals');
    expect(totals.textContent).toContain('480');
    expect(totals.textContent).toContain('3');
    expect(totals.textContent).toContain('99.38%');
  });

  it('renders "no data" rather than 100% when no sessions were reported', async () => {
    // 100% of nothing is the figure that gets acted on when it should not be.
    renderSection({ reports: [], total: 0, totalSuccessfulSessions: 0, totalFailedSessions: 0, successRate: null });
    const totals = await screen.findByTestId('tls-totals');
    expect(totals.textContent).toContain('no data');
    expect(totals.textContent).not.toContain('100.00%');
  });

  it('expands to the failure breakdown an operator can act on', async () => {
    renderSection();
    fireEvent.click(await screen.findByTestId('tls-row-r-1'));
    expect(screen.getByText('certificate-expired')).toBeInTheDocument();
    expect(screen.getByText('mx.tenant.test')).toBeInTheDocument();
  });

  it('says an empty list is not a fault', async () => {
    renderSection({ reports: [], total: 0, totalSuccessfulSessions: 0, totalFailedSessions: 0, successRate: null });
    expect(await screen.findByText(/not a fault/)).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty table', async () => {
    apiFetch.mockRejectedValue(new Error('boom'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><TlsReportsSection /></QueryClientProvider>);
    expect(await screen.findByText(/Could not load TLS reports/)).toBeInTheDocument();
  });

  it('asks the API for failures only when the filter is set', async () => {
    renderSection();
    await screen.findByTestId('tls-totals');
    fireEvent.click(screen.getByTestId('tls-failing-only'));
    await vi.waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('failingOnly=true'));
    });
  });
});
