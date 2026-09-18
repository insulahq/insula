/**
 * Tenant Delivery Security tab.
 *
 * Must request only its own tenant, and must not tell a tenant that "100%" of
 * nothing succeeded. The failure copy points at support rather than at DNS,
 * because the certificate and MX are the platform's, not theirs.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: TlsTab } = await import('./TlsTab');

const report = () => ({
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
});

function renderTab(over: Record<string, unknown> = {}) {
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
  return render(<QueryClientProvider client={qc}><TlsTab tenantId="t-1" /></QueryClientProvider>);
}

beforeEach(() => { apiFetch.mockReset(); });

describe('tenant TlsTab', () => {
  it('requests only this tenant’s reports', async () => {
    renderTab();
    await screen.findByTestId('tenant-tls-totals');
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/tenants/t-1/mail/tls-reports'),
    );
  });

  it('renders "no data" rather than 100% when nothing was reported', async () => {
    renderTab({ reports: [], total: 0, totalSuccessfulSessions: 0, totalFailedSessions: 0, successRate: null });
    const totals = await screen.findByTestId('tenant-tls-totals');
    expect(totals.textContent).toContain('no data');
  });

  it('points a failing report at support, not at the tenant’s DNS', async () => {
    // The certificate and MX are platform-managed; telling a tenant to fix
    // them would send them somewhere they have no control.
    renderTab();
    fireEvent.click(await screen.findByTestId('tenant-tls-row-r-1'));
    expect(screen.getByText(/contact support/i)).toBeInTheDocument();
  });

  it('explains that an empty list is not a fault', async () => {
    renderTab({ reports: [], total: 0, totalSuccessfulSessions: 0, totalFailedSessions: 0, successRate: null });
    expect(await screen.findByText(/does not mean anything is wrong/)).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty table', async () => {
    apiFetch.mockRejectedValue(new Error('boom'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><TlsTab tenantId="t-1" /></QueryClientProvider>);
    expect(await screen.findByText(/Could not load TLS reports/)).toBeInTheDocument();
  });
});
