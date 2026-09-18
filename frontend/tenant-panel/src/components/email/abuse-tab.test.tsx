/**
 * Tenant Abuse Reports tab.
 *
 * The tenant view has one extra obligation the admin one does not: it must
 * only ever request its own tenant's reports. The scope is enforced server
 * side, but a wrong URL here would mean the page silently shows nothing (or,
 * worse, somebody else's) — so the request itself is asserted.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: AbuseTab } = await import('./AbuseTab');

const report = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  feedbackType: 'abuse',
  domain: 'tenant.test',
  tenantId: 't-1',
  tenantName: 'Tenant Ltd',
  originalMailFrom: 'news@tenant.test',
  originalRcptTo: 'someone@reporter.test',
  sourceIp: '203.0.113.9',
  reportingMta: 'mx.reporter.test',
  reporter: 'abuse-desk@reporter.test',
  subject: 'Unsolicited bulk mail',
  incidents: 3,
  receivedAt: '2026-09-18T10:00:00Z',
  ...over,
});

function renderTab(data: Record<string, unknown> = {}) {
  apiFetch.mockResolvedValue({
    data: { windowDays: 30, reports: [report()], total: 1, intakeLocalPart: 'abuse', ...data },
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AbuseTab tenantId="t-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe('tenant AbuseTab', () => {
  it('requests only this tenant’s reports', async () => {
    renderTab();
    await screen.findByText('news@tenant.test');
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/tenants/t-1/mail/abuse-reports'),
    );
  });

  it('leads with the address that sent the complained-about mail', async () => {
    // The tenant's first question is "which of mine did this?", not "which
    // domain" — they own one domain in this view.
    renderTab();
    expect(await screen.findByText('news@tenant.test')).toBeInTheDocument();
  });

  it('shows the incident multiplier rather than implying a single complaint', async () => {
    renderTab();
    expect(await screen.findByText('3×')).toBeInTheDocument();
  });

  it('explains why an empty list is normal', async () => {
    renderTab({ reports: [], total: 0 });
    expect(await screen.findByText(/No abuse reports in the last 30 days/)).toBeInTheDocument();
  });

  it('expands to the detail a tenant needs to fix the source', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('tenant-abuse-row-r-1'));
    expect(screen.getByText('abuse-desk@reporter.test')).toBeInTheDocument();
    expect(screen.getByText('someone@reporter.test')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty table', async () => {
    apiFetch.mockRejectedValue(new Error('boom'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AbuseTab tenantId="t-1" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Could not load abuse reports/)).toBeInTheDocument();
  });
});
