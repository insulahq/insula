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

function renderTab(selectedDomain = 'shop.example.test') {
  apiFetch.mockResolvedValue({
    data: {
      windowDays: 7,
      domains: [
        row('shop.example.test', 140, { rateLimited7d: 3 }),
        row('news.example.test', 700),
        row('quiet.example.test', 0),
        row('relay.example.test', 21, { emailHosted: false }),
      ],
    },
  });
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
});
