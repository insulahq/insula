/**
 * The tenant Email tab's daily chart and the words for a limit holding mail.
 *
 * The limits are per mail domain: the chart opens on the busiest domain with
 * the daily limit line, and the all-domains view draws no line — against a sum
 * it would read "over the limit" on days nothing was held. Held mail sits
 * inside the sent bar (it was accepted); it used to be stacked on top of it,
 * counting it twice.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MailThrottle } from '@insula/api-contracts';

const { dailyFn, statsFn } = vi.hoisted(() => ({ dailyFn: vi.fn(), statsFn: vi.fn() }));
vi.mock('@/hooks/use-tenant-insights', () => ({
  useTenantMailDaily: (...a: unknown[]) => dailyFn(...a),
  useTenantMailDomainStats: () => statsFn(),
}));

const { default: MailDailyChart } = await import('../components/tenant-detail/MailDailyChart');
const { throttleText, throttlesSummary } = await import('../components/tenant-detail/mail-throttle');

const day = (date: string, sent: number, rateLimited = 0, quotaRejected = 0) => ({ date, sent, recipients: sent, rateLimited, quotaRejected });

beforeEach(() => {
  statsFn.mockReturnValue({ data: { data: { domains: [{ domain: 'shop.example.test' }, { domain: 'news.example.test' }] } } });
  dailyFn.mockImplementation((_t: string | undefined, domain: string | null) => ({
    isLoading: false,
    data: { data: { domain, dailyLimit: 100, days: [day('2026-11-15', 40), day('2026-11-16', 101, 9, 1)] } },
  }));
});

describe('MailDailyChart', () => {
  it('opens on the busiest domain, with its daily limit', () => {
    render(<MailDailyChart tenantId="t-1" />);
    expect(dailyFn).toHaveBeenLastCalledWith('t-1', 'shop.example.test');
    expect(screen.getByText('Daily limit 100')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('shop.example.test:');
  });

  it('draws held mail inside the sent bar and refused mail on top', () => {
    render(<MailDailyChart tenantId="t-1" />);
    const today = screen.getByTestId('mail-day-2026-11-16');
    expect(today.children).toHaveLength(3);
    expect(today.getAttribute('title')).toBe('2026-11-16: 101 sent (9 held back, sent later), 1 refused, 101 recipients');
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe('shop.example.test: 141 messages sent, 9 of them held back, and 1 refused over the last 2 days, daily limit 100');
  });

  it('switches domain, and draws no limit line for all domains together', () => {
    render(<MailDailyChart tenantId="t-1" />);
    fireEvent.change(screen.getByTestId('mail-daily-domain'), { target: { value: 'news.example.test' } });
    expect(dailyFn).toHaveBeenLastCalledWith('t-1', 'news.example.test');
    fireEvent.change(screen.getByTestId('mail-daily-domain'), { target: { value: '' } });
    expect(dailyFn).toHaveBeenLastCalledWith('t-1', null);
    expect(screen.queryByText(/Daily limit/)).toBeNull();
  });

  it('waits for the domain list before asking, so the first request is the right one', () => {
    statsFn.mockReturnValue({ data: undefined });
    render(<MailDailyChart tenantId="t-1" />);
    expect(dailyFn).toHaveBeenLastCalledWith(undefined, null);
    expect(screen.getByText(/Loading/)).toBeTruthy();
  });
});

describe('throttle wording', () => {
  const t: MailThrottle = {
    domain: 'shop.example.test', emailDomainId: 'ed-1', window: 'day', heldNow: 10,
    releasesAt: '2026-11-17T00:00:00.000Z', heldToday: 10, refusedToday: 0, refusing: false,
    sentThisHour: 10, sentToday: 101,
  };

  it('says how much is held back and until when, in the viewer\'s zone', () => {
    expect(throttleText(t)).toMatch(/^10 messages held back until 2026-11-1[67] \d\d:00 UTC/);
  });

  it('says when new mail is refused, and how much was today', () => {
    expect(throttleText({ ...t, heldNow: 0, releasesAt: null, refusing: true, refusedToday: 3 }))
      .toBe('new mail refused while the queue is full · 3 refused today');
  });

  it('names the one domain, or counts several', () => {
    expect(throttlesSummary([t])).toMatch(/^shop\.example\.test: 10 messages held back/);
    expect(throttlesSummary([t, { ...t, domain: 'news.example.test', heldNow: 1 }])).toBe('2 domains at their limit · 11 messages held back');
    expect(throttlesSummary([])).toBeNull();
  });
});
