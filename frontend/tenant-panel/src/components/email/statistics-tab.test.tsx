/**
 * Tenant Email → Statistics.
 *
 * Asks for its own tenant only; shows the domain picked at the top of the page
 * as figures, every domain in a sortable table, a quiet domain as zeros, and a
 * domain that only relays as such.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: StatisticsTab } = await import('./StatisticsTab');

const row = (domain: string, sent7d: number, over: Record<string, unknown> = {}) => ({
  domain, emailHosted: true, sent24h: Math.floor(sent7d / 7), sent7d, recipients7d: sent7d * 2,
  rateLimited7d: 0, quotaRejected7d: 0, ...over,
});

const THROTTLE = {
  domain: 'shop.example.test', emailDomainId: 'ed-1', window: 'day', heldNow: 9,
  releasesAt: '2026-11-17T00:00:00.000Z', heldToday: 9, refusedToday: 1, refusing: false,
  sentThisHour: 10, sentToday: 101,
};

const DAYS = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-11-${String(3 + i).padStart(2, '0')}`, sent: i === 13 ? 101 : 20, recipients: 20,
  rateLimited: i === 13 ? 9 : 0, quotaRejected: i === 13 ? 1 : 0,
}));

function renderTab(selectedDomain = 'shop.example.test', shopOver: Record<string, unknown> = {}) {
  apiFetch.mockImplementation(async (url: string) => (url.includes('/mail/daily')
    ? { data: { domain: selectedDomain, dailyLimit: 100, days: DAYS } }
    : {
      data: {
        windowDays: 7, hourlyLimit: 50, dailyLimit: 100, outboundSuspended: false,
        domains: [
          row('shop.example.test', 140, { rateLimited7d: 3, ...shopOver }),
          row('news.example.test', 700),
          row('quiet.example.test', 0),
          row('relay.example.test', 21, { emailHosted: false }),
        ],
      },
    }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StatisticsTab tenantId="t-1" selectedDomain={selectedDomain} />
    </QueryClientProvider>,
  );
}

const domainsShown = (): string[] =>
  within(screen.getByTestId('email-statistics-table')).getAllByRole('row').slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].textContent?.replace('sending only', '') ?? '');

beforeEach(() => { apiFetch.mockReset(); });

describe('StatisticsTab', () => {
  it('asks for this tenant’s figures', async () => {
    renderTab();
    await screen.findByTestId('email-statistics');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/tenants/t-1/mail/domain-stats');
  });

  it('shows the selected domain’s figures, the deferred count marked', async () => {
    renderTab();
    const figures = await screen.findByTestId('email-statistics-selected');
    expect(figures.textContent).toContain('Sent (24h)20');
    expect(figures.textContent).toContain('Sent (7d)140');
    expect(figures.textContent).toContain('Recipients (7d)280');
    expect(within(figures).getByText('3').className).toMatch(/amber/);
  });

  it('lists every domain, busiest first, and re-sorts by a column', async () => {
    renderTab();
    await screen.findByTestId('email-statistics-table');
    expect(domainsShown()).toEqual(['news.example.test', 'shop.example.test', 'relay.example.test', 'quiet.example.test']);
    fireEvent.click(within(screen.getByTestId('email-statistics-table')).getByTestId('sort-domain'));
    expect(domainsShown()).toEqual(['news.example.test', 'quiet.example.test', 'relay.example.test', 'shop.example.test']);
  });

  it('marks a domain that only sends through the relay', async () => {
    renderTab();
    const relay = await screen.findByTestId('email-statistics-row-relay.example.test');
    expect(relay.textContent).toContain('sending only');
    expect(screen.getByTestId('email-statistics-row-shop.example.test').textContent).not.toContain('sending only');
  });

  it('shows zeros for a selected domain that has sent nothing yet', async () => {
    renderTab('new.example.test');
    const figures = await screen.findByTestId('email-statistics-selected');
    expect(figures.textContent).toContain('Sent (7d)0');
  });

  // The page the dashboard card and the limit notifications open.
  it('says which limit is full, what is held back and until when, and that it is not lost', async () => {
    renderTab('shop.example.test', { sentToday: 101, sentThisHour: 10, throttle: THROTTLE });
    const banner = await screen.findByTestId('email-statistics-throttle');
    expect(banner.textContent).toContain('The daily sending limit is reached for shop.example.test');
    expect(banner.textContent).toContain('9 messages held back until');
    expect(banner.textContent).toContain('1 refused today');
    expect(banner.textContent).toContain('Mail over a limit is not lost');
    const today = screen.getByTestId('email-statistics-today');
    expect(today.textContent).toContain('Sent today101of 100');
    expect(today.textContent).toContain('Sent this hour10of 50');
    expect(today.textContent).toContain('Held back now9');
    expect(today.textContent).toContain('Refused today1');
  });

  it('shows no banner for a domain no limit is holding', async () => {
    renderTab();
    await screen.findByTestId('email-statistics-today');
    expect(screen.queryByTestId('email-statistics-throttle')).toBeNull();
  });

  it('draws the selected domain\'s last 14 days, held mail inside the sent bar and refused on top', async () => {
    renderTab('shop.example.test', { throttle: THROTTLE });
    const today = await screen.findByTestId('email-statistics-day-2026-11-16');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/tenants/t-1/mail/daily?domain=shop.example.test');
    expect(screen.getByText('Sent per day, last 14 days')).toBeTruthy();
    expect(today.getAttribute('title')).toBe('2026-11-16: 101 sent (9 held back, sent later), 1 refused, 20 recipients');
    // Three segments: refused, held, the rest of the sent mail.
    expect(today.children).toHaveLength(3);
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe('shop.example.test: 361 messages sent, 9 of them held back, and 1 refused over the last 14 days, daily limit 100');
  });

  it('copes with an API one release behind (no today fields yet)', async () => {
    apiFetch.mockImplementation(async (url: string) => (url.includes('/mail/daily')
      ? { data: { days: [] } }
      : { data: { windowDays: 7, domains: [{ domain: 'shop.example.test', emailHosted: true, sent24h: 1, sent7d: 2, recipients7d: 2, rateLimited7d: 0, quotaRejected7d: 0 }] } }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><StatisticsTab tenantId="t-1" selectedDomain="shop.example.test" /></QueryClientProvider>);
    const today = await screen.findByTestId('email-statistics-today');
    expect(today.textContent).toContain('Sent today0');
  });
});
