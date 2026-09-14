import { describe, expect, it } from 'vitest';
import { DMARC_RECOMMENDATION, nextPolicy, recommendPolicy, type DmarcDomainStats } from './dmarc-policy.js';

/**
 * The value of this module is in NOT recommending a tightening too early.
 * `p=reject` on a domain with one legitimate unaligned sender does not degrade
 * — that sender's mail stops being delivered, to everyone, immediately. So most
 * of these tests assert a REFUSAL, and each one names the trap it guards.
 */
const ready = (over: Partial<DmarcDomainStats> = {}): DmarcDomainStats => ({
  policyDomain: 'example.test',
  currentPolicy: 'none',
  reportCount: 40,
  totalMessages: 10_000,
  passMessages: 10_000,
  windowDays: 30,
  failingSources: 0,
  ...over,
});

describe('nextPolicy', () => {
  it('walks none -> quarantine -> reject and stops', () => {
    expect(nextPolicy(null)).toBe('none');
    expect(nextPolicy('none')).toBe('quarantine');
    expect(nextPolicy('quarantine')).toBe('reject');
    expect(nextPolicy('reject')).toBeNull();
  });
});

describe('recommendPolicy — when it says go', () => {
  it('recommends quarantine from none on a long clean history', () => {
    const r = recommendPolicy(ready());
    expect(r.recommendedPolicy).toBe('quarantine');
    expect(r.ready).toBe(true);
    expect(r.passRate).toBe(1);
    expect(r.reason).toContain('safe to move to p=quarantine');
  });

  it('recommends reject from quarantine', () => {
    const r = recommendPolicy(ready({ currentPolicy: 'quarantine' }));
    expect(r.recommendedPolicy).toBe('reject');
    expect(r.ready).toBe(true);
  });

  it('holds reject to a higher bar than quarantine', () => {
    // 99.2% clears quarantine's 99% and misses reject's 99.5%.
    const stats = ready({ totalMessages: 10_000, passMessages: 9_920 });
    expect(recommendPolicy({ ...stats, currentPolicy: 'none' }).recommendedPolicy).toBe('quarantine');
    const rej = recommendPolicy({ ...stats, currentPolicy: 'quarantine' });
    expect(rej.recommendedPolicy).toBeNull();
    expect(rej.ready).toBe(false);
    expect(rej.reason).toContain('99.5%');
  });
});

describe('recommendPolicy — when it refuses', () => {
  it('refuses with no reports, and reports the rate as null rather than 0% or 100%', () => {
    // A rate with no denominator is undefined. Reporting 0% would look like a
    // catastrophe and 100% like a clean bill of health; both are claims the
    // data does not support.
    const r = recommendPolicy(ready({ reportCount: 0, totalMessages: 0, passMessages: 0 }));
    expect(r.passRate).toBeNull();
    expect(r.ready).toBe(false);
    expect(r.recommendedPolicy).toBeNull();
    expect(r.reason).toContain('No DMARC reports');
  });

  it('tells an unpublished domain how to start collecting reports', () => {
    const r = recommendPolicy(ready({ currentPolicy: null, reportCount: 0, totalMessages: 0 }));
    expect(r.reason).toContain('rua=');
  });

  it('refuses on a short window even at a perfect pass rate', () => {
    // Three clean days has not yet seen the weekly billing run.
    const r = recommendPolicy(ready({ windowDays: 3 }));
    expect(r.ready).toBe(false);
    expect(r.reason).toContain(`${DMARC_RECOMMENDATION.MIN_WINDOW_DAYS}`);
  });

  it('refuses on a tiny denominator even at 100%', () => {
    // 100% of 12 messages is one quiet week, not evidence.
    const r = recommendPolicy(ready({ totalMessages: 12, passMessages: 12, reportCount: 6 }));
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('Too little traffic');
  });

  it('refuses on too few reports even with plenty of messages', () => {
    const r = recommendPolicy(ready({ reportCount: 2 }));
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('report(s)');
  });

  it('refuses below the pass-rate floor and says why tightening would hurt', () => {
    const r = recommendPolicy(ready({ totalMessages: 10_000, passMessages: 9_500 }));
    expect(r.ready).toBe(false);
    expect(r.passRate).toBeCloseTo(0.95);
    expect(r.reason).toContain('would stop their mail');
  });

  it('refuses while any source is still failing, even at a passing rate', () => {
    // The trap this exists for: the aggregate rate can clear the bar while a
    // low-volume legitimate sender fails every message it sends. That sender
    // is exactly who breaks on a tightening, and it is invisible in the rate.
    const r = recommendPolicy(ready({ totalMessages: 10_000, passMessages: 9_990, failingSources: 1 }));
    expect(r.ready).toBe(false);
    expect(r.recommendedPolicy).toBeNull();
    expect(r.reason).toContain('1 source(s) are still failing');
  });

  it('says nothing to do at p=reject', () => {
    const r = recommendPolicy(ready({ currentPolicy: 'reject' }));
    expect(r.recommendedPolicy).toBeNull();
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('strictest');
  });

  it('never returns an empty reason', () => {
    const cases: Partial<DmarcDomainStats>[] = [
      {}, { reportCount: 0, totalMessages: 0 }, { windowDays: 1 }, { totalMessages: 5, passMessages: 5 },
      { passMessages: 100 }, { failingSources: 3 }, { currentPolicy: 'reject' }, { currentPolicy: null },
    ];
    for (const c of cases) {
      expect(recommendPolicy(ready(c)).reason.length).toBeGreaterThan(0);
    }
  });

  it('ready is never true without a recommendation, and vice versa', () => {
    // The UI gates on `ready`; the two must not be able to disagree.
    const cases: Partial<DmarcDomainStats>[] = [
      {}, { windowDays: 2 }, { failingSources: 1 }, { currentPolicy: 'reject' },
      { reportCount: 0, totalMessages: 0 }, { passMessages: 9_000 },
    ];
    for (const c of cases) {
      const r = recommendPolicy(ready(c));
      expect(r.ready).toBe(r.recommendedPolicy !== null);
    }
  });
});
