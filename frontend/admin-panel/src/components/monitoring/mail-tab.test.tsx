/**
 * Monitoring → Mail.
 *
 * Pinned: the mail server's health checks head the page (the mail-health,
 * blocklist and deliverability notifications open it), and the sending-domain
 * table searches, sorts and pages every domain rather than showing ten.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: MailTab } = await import('./MailTab');

const sender = (i: number) => ({
  tenantId: `t-${i}`, tenantName: `Tenant ${i}`, domain: `d${String(i).padStart(2, '0')}.test`,
  sent24h: i, sent7d: i * 10, rateLimited7d: 0, quotaRejected7d: 0,
});

function overview(senders: number) {
  return {
    data: {
      totals: { sent24h: 1, sent7d: 2, recipients7d: 3, rateLimited7d: 0, quotaRejected7d: 0 },
      topSenders: Array.from({ length: senders }, (_, i) => sender(i + 1)),
      queue: { reachable: true, depth: 0, truncated: false, entries: [] },
      protection: { mode: 'notify' },
    },
  };
}

function route(senders: number) {
  apiFetch.mockImplementation((...args: unknown[]) => {
    const url = String(args[0]);
    // Left pending: the banner's own loading state is enough to see where it sits.
    if (url === '/api/v1/admin/mail/health') return new Promise(() => undefined);
    if (url === '/api/v1/admin/mail/overview') return Promise.resolve(overview(senders));
    if (url.startsWith('/api/v1/admin/mail/dmarc')) return Promise.resolve({ data: { windowDays: 30, domains: [], intakeLocalPart: 'dmarc' } });
    if (url.startsWith('/api/v1/admin/mail/abuse-reports')) return Promise.resolve({ data: { windowDays: 30, reports: [], total: 0, intakeLocalPart: 'abuse' } });
    if (url.startsWith('/api/v1/admin/mail/tls-reports')) {
      return Promise.resolve({ data: { windowDays: 30, reports: [], total: 0, totalSuccessfulSessions: 0, totalFailedSessions: 0, successRate: null, intakeLocalPart: 'postmaster' } });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MailTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const domainsShown = (): string[] =>
  within(screen.getByTestId('top-senders-table')).getAllByRole('row').slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].textContent ?? '');

beforeEach(() => { apiFetch.mockReset(); });

describe('MailTab', () => {
  it('opens with the mail server health checks, above the send figures', async () => {
    route(3);
    renderTab();
    const banner = screen.getByText(/Probing mail-server health/);
    const table = await screen.findByTestId('top-senders-table');
    expect(banner.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists every sending domain, most mail first, twenty to a page', async () => {
    route(25);
    renderTab();
    await screen.findByTestId('top-senders-table');
    expect(domainsShown()).toHaveLength(20);
    expect(domainsShown()[0]).toBe('d25.test');
    fireEvent.click(screen.getByTestId('top-senders-pagination-next'));
    expect(domainsShown()).toEqual(['d05.test', 'd04.test', 'd03.test', 'd02.test', 'd01.test']);
  });

  it('shows all of them on one page when All is picked', async () => {
    route(25);
    renderTab();
    await screen.findByTestId('top-senders-table');
    fireEvent.change(screen.getByTestId('top-senders-page-size-select'), { target: { value: '-1' } });
    expect(domainsShown()).toHaveLength(25);
    expect(screen.getByTestId('top-senders-pagination-bar').textContent).toMatch(/Showing 1-25 of 25/);
  });

  it('finds a domain on a later page by searching, by domain or by tenant', async () => {
    route(25);
    renderTab();
    await screen.findByTestId('top-senders-table');
    fireEvent.change(screen.getByTestId('top-senders-search'), { target: { value: 'd02' } });
    expect(domainsShown()).toEqual(['d02.test']);
    fireEvent.change(screen.getByTestId('top-senders-search'), { target: { value: 'tenant 13' } });
    expect(domainsShown()).toEqual(['d13.test']);
  });

  it('sorts by a column header, and again the other way', async () => {
    route(3);
    renderTab();
    await screen.findByTestId('top-senders-table');
    fireEvent.click(within(screen.getByTestId('top-senders-table')).getByTestId('sort-domain'));
    expect(domainsShown()).toEqual(['d01.test', 'd02.test', 'd03.test']);
    fireEvent.click(within(screen.getByTestId('top-senders-table')).getByTestId('sort-domain'));
    expect(domainsShown()).toEqual(['d03.test', 'd02.test', 'd01.test']);
  });
});
