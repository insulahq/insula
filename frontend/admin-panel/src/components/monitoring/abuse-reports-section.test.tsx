/**
 * Abuse reports section.
 *
 * The behaviours worth pinning are the ones that would quietly mislead:
 *   - an empty list must read as "none arrived", never as "nothing is wrong",
 *     and must not imply ingestion is broken either;
 *   - an UNATTRIBUTED complaint must still be shown, and visibly marked —
 *     hiding it makes the abuse desk look quiet exactly when somebody is
 *     spoofing a tenant domain;
 *   - a capped list must say so, or "12 reports" reads as the whole truth.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: AbuseReportsSection } = await import('./AbuseReportsSection');

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
  incidents: 1,
  receivedAt: '2026-09-18T10:00:00Z',
  ...over,
});

function overview(over: Record<string, unknown> = {}) {
  return {
    data: {
      windowDays: 30,
      reports: [report()],
      total: 1,
      intakeLocalPart: 'abuse',
      ...over,
    },
  };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AbuseReportsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe('AbuseReportsSection', () => {
  it('lists a complaint with the tenant it was attributed to', async () => {
    apiFetch.mockResolvedValue(overview());
    renderSection();
    expect(await screen.findByText('tenant.test')).toBeInTheDocument();
    expect(screen.getByText('Tenant Ltd')).toBeInTheDocument();
    expect(screen.getByText('Abuse')).toBeInTheDocument();
  });

  it('shows an UNATTRIBUTED complaint and marks it as such', async () => {
    apiFetch.mockResolvedValue(overview({
      reports: [report({ tenantId: null, tenantName: null, domain: 'notours.test' })],
    }));
    renderSection();
    expect(await screen.findByText('notours.test')).toBeInTheDocument();
    expect(screen.getByText('unattributed')).toBeInTheDocument();
  });

  it('says an empty list is normal rather than implying all-clear or breakage', async () => {
    apiFetch.mockResolvedValue(overview({ reports: [], total: 0 }));
    renderSection();
    const empty = await screen.findByText(/No abuse reports in the last 30 days/);
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toMatch(/normal state/i);
  });

  it('discloses when the list is capped, so a count is not read as the total', async () => {
    apiFetch.mockResolvedValue(overview({ reports: [report()], total: 57 }));
    renderSection();
    expect(await screen.findByText(/Showing the 1 most recent of 57/)).toBeInTheDocument();
  });

  it('reveals the actionable detail on expand — who complained, and about which message', async () => {
    apiFetch.mockResolvedValue(overview());
    renderSection();
    fireEvent.click(await screen.findByTestId('abuse-row-r-1'));
    expect(screen.getByText('abuse-desk@reporter.test')).toBeInTheDocument();
    expect(screen.getAllByText('news@tenant.test').length).toBeGreaterThan(0);
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of rendering an empty table', async () => {
    // `data ?? []` would turn a 500 into "no complaints" — the one reading an
    // abuse desk must never get.
    apiFetch.mockRejectedValue(new Error('boom'));
    renderSection();
    expect(await screen.findByText(/Could not load abuse reports/)).toBeInTheDocument();
  });
});
