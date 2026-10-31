/**
 * The renewal policy must hold for EVERY lifetime a CA may issue, not only
 * today's 90 days: a healthy certificate is never "expiring" before or at its
 * renewal point, and one whose renewal has not happened is flagged with time
 * to spare.
 */
import { describe, it, expect } from 'vitest';
import {
  certificateExpiryState,
  EXPIRING_REMAINING_FRACTION,
  MANUAL_CERT_EXPIRING_DAYS,
  RENEW_BEFORE_PERCENTAGE,
} from './renewal-policy.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-31T12:00:00Z');

/** A certificate of `lifetimeDays` with `leftDays` of it remaining at NOW. */
const cert = (lifetimeDays: number, leftDays: number) => {
  const notAfter = new Date(NOW.getTime() + leftDays * DAY);
  return { notBefore: new Date(notAfter.getTime() - lifetimeDays * DAY), notAfter };
};
const auto = (c: ReturnType<typeof cert>) => certificateExpiryState(c, { autoRenewed: true, now: NOW });

// Today's Let's Encrypt default, its 2027 and 2028 defaults, its opt-in
// 45-day and 6-day profiles, and a one-year commercial certificate.
const LIFETIMES = [90, 89, 64, 45, 6, 365];

describe('renewal policy — auto-renewed certificates', () => {
  it('renews with a third of the lifetime left, and warns at half of that', () => {
    expect(RENEW_BEFORE_PERCENTAGE).toBe(33);
    expect(EXPIRING_REMAINING_FRACTION).toBeCloseTo(0.165);
  });

  it.each(LIFETIMES)('a %i-day certificate is never "expiring" from issue down to its renewal point', (life) => {
    const renewalPoint = life * RENEW_BEFORE_PERCENTAGE / 100;
    // Every hour from a fresh certificate down to the renewal point.
    for (let left = life; left >= renewalPoint; left -= 1 / 24) {
      expect(auto(cert(life, left)), `${life}-day cert, ${left.toFixed(2)} days left`).toBe('valid');
    }
  });

  it.each(LIFETIMES)('a %i-day certificate that missed its renewal turns "expiring" with time left to act', (life) => {
    const warnAt = life * EXPIRING_REMAINING_FRACTION;
    expect(auto(cert(life, warnAt + 0.01))).toBe('valid');
    expect(auto(cert(life, warnAt - 0.01))).toBe('expiring');
    // The warning comes well before the end: half the renewal window is left.
    expect(warnAt).toBeGreaterThan(life * 0.16);
    expect(auto(cert(life, -0.01))).toBe('expired');
  });

  it('measures the lifetime the CA issued, not today\'s default (the reported case)', () => {
    // 21 days left on an 89-day certificate: inside its renewal window, renewing
    // now — the old fixed 30-day mark showed this orange.
    expect(auto(cert(89, 21))).toBe('valid');
    // 21 days left on a 365-day certificate whose renewal (at ~120 days) never
    // happened: overdue.
    expect(auto(cert(365, 21))).toBe('expiring');
  });

  it('assumes a 90-day lifetime while the start is unknown, which still leaves 45-day certificates unflagged at renewal', () => {
    const unknown = (left: number) =>
      certificateExpiryState({ notBefore: null, notAfter: new Date(NOW.getTime() + left * DAY) }, { autoRenewed: true, now: NOW });
    expect(unknown(15)).toBe('valid'); // a 45-day cert renews at ~15 days left
    expect(unknown(14)).toBe('expiring');
  });

  it('ignores a start that is not before the end, and treats an unknown end as unknown', () => {
    const notAfter = new Date(NOW.getTime() + 20 * DAY);
    expect(certificateExpiryState({ notBefore: notAfter, notAfter }, { autoRenewed: true, now: NOW })).toBe('valid');
    expect(certificateExpiryState({ notBefore: null, notAfter: null }, { autoRenewed: true, now: NOW })).toBeNull();
  });
});

describe('renewal policy — certificates nobody renews automatically', () => {
  it('warns a fixed 30 days ahead, whatever the lifetime: someone has to upload the next one', () => {
    const manual = (life: number, left: number) => certificateExpiryState(cert(life, left), { autoRenewed: false, now: NOW });
    expect(MANUAL_CERT_EXPIRING_DAYS).toBe(30);
    expect(manual(365, 31)).toBe('valid');
    expect(manual(365, 29)).toBe('expiring');
    expect(manual(90, 29)).toBe('expiring');
    expect(manual(90, -1)).toBe('expired');
  });
});
