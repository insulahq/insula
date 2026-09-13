/**
 * DMARC policy recommendation (ROADMAP R5).
 *
 * Answers one question for a domain: *is it safe to tighten the published
 * policy yet?* — `p=none` → `p=quarantine` → `p=reject`.
 *
 * The whole value of this is in NOT recommending a tightening too early.
 * `p=reject` on a domain that still has a legitimate unaligned sender does not
 * degrade: that sender's mail stops being delivered, to everyone, immediately.
 * So every rule here is written to fail closed — an absent, thin, or short
 * history produces "keep observing", never "go ahead".
 *
 * Deliberately NOT automatic. This produces a recommendation an operator acts
 * on; nothing in the platform rewrites a published policy on its own.
 */

/** The DMARC policies a domain can publish, in tightening order. */
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

const ORDER: readonly DmarcPolicy[] = ['none', 'quarantine', 'reject'];

/**
 * Thresholds. Deliberately conservative, and stated here rather than inlined so
 * the reasoning is reviewable in one place.
 */
export const DMARC_RECOMMENDATION = {
  /**
   * Below this, a tightening is never recommended. 99% is not arbitrary: at
   * 98%, one message in fifty from a legitimate unaligned source would start
   * being quarantined, and at typical volumes that is a support ticket a day.
   */
  MIN_PASS_RATE: 0.99,
  /** `p=reject` is the irreversible-feeling one; hold it to a higher bar. */
  MIN_PASS_RATE_REJECT: 0.995,
  /**
   * A window shorter than this has not yet seen a weekly-cadence sender — the
   * billing run, the Monday digest, the monthly invoice. Tightening on three
   * days of clean traffic is how those break.
   */
  MIN_WINDOW_DAYS: 14,
  /** Fewer reports than this is not a trend, whatever the rate says. */
  MIN_REPORTS: 5,
  /**
   * A denominator this small makes the rate meaningless: 100% of 12 messages
   * is one quiet week, not evidence.
   */
  MIN_MESSAGES: 100,
} as const;

export interface DmarcDomainStats {
  readonly policyDomain: string;
  /** Currently published policy, as reported by the reporters themselves. */
  readonly currentPolicy: DmarcPolicy | null;
  readonly reportCount: number;
  readonly totalMessages: number;
  readonly passMessages: number;
  /** Span actually covered by the reports, in whole days. */
  readonly windowDays: number;
  /** Distinct source IPs that failed at least one message in the window. */
  readonly failingSources: number;
}

export interface DmarcRecommendation {
  readonly policyDomain: string;
  readonly currentPolicy: DmarcPolicy | null;
  /** What to publish next, or null when nothing should change yet. */
  readonly recommendedPolicy: DmarcPolicy | null;
  readonly passRate: number | null;
  /** One sentence an operator can act on. Never empty. */
  readonly reason: string;
  /**
   * True only when every threshold is met. The UI gates its "tighten" hint on
   * this rather than on `recommendedPolicy != null`, so a future caller cannot
   * read a null-because-unknown as a null-because-fine.
   */
  readonly ready: boolean;
}

/** Next policy in tightening order, or null when already at the strictest. */
export function nextPolicy(current: DmarcPolicy | null): DmarcPolicy | null {
  if (current === null) return 'none';
  const i = ORDER.indexOf(current);
  if (i < 0 || i === ORDER.length - 1) return null;
  return ORDER[i + 1];
}

/**
 * Recommend a policy for one domain.
 *
 * Order of checks matters: the reasons are reported most-blocking first, so an
 * operator with no data at all is told that, rather than being told their pass
 * rate is too low when the rate is computed from nothing.
 */
export function recommendPolicy(stats: DmarcDomainStats): DmarcRecommendation {
  const base = { policyDomain: stats.policyDomain, currentPolicy: stats.currentPolicy };

  if (stats.reportCount === 0 || stats.totalMessages === 0) {
    // No denominator. A rate is undefined here, not 0% and not 100% — and
    // reporting either would be a claim the data does not support.
    return {
      ...base,
      recommendedPolicy: null,
      passRate: null,
      ready: false,
      reason: stats.currentPolicy === null
        ? 'No DMARC reports received yet. Publish a DMARC record with a rua= address to start collecting them.'
        : 'No DMARC reports received yet for this domain — nothing to judge a policy change on.',
    };
  }

  const passRate = stats.passMessages / stats.totalMessages;
  const target = nextPolicy(stats.currentPolicy);

  if (target === null) {
    return {
      ...base,
      recommendedPolicy: null,
      passRate,
      ready: false,
      reason: 'Already at the strictest policy (p=reject). Keep watching the pass rate.',
    };
  }

  const pct = (passRate * 100).toFixed(1);

  if (stats.windowDays < DMARC_RECOMMENDATION.MIN_WINDOW_DAYS) {
    return {
      ...base,
      recommendedPolicy: null,
      passRate,
      ready: false,
      reason: `Only ${stats.windowDays} day(s) of reports so far — ${DMARC_RECOMMENDATION.MIN_WINDOW_DAYS} are needed before tightening, so weekly and monthly senders have had a chance to appear.`,
    };
  }

  if (stats.reportCount < DMARC_RECOMMENDATION.MIN_REPORTS
    || stats.totalMessages < DMARC_RECOMMENDATION.MIN_MESSAGES) {
    return {
      ...base,
      recommendedPolicy: null,
      passRate,
      ready: false,
      reason: `Too little traffic to judge: ${stats.totalMessages} message(s) across ${stats.reportCount} report(s). ${pct}% passing is not yet evidence.`,
    };
  }

  const required = target === 'reject'
    ? DMARC_RECOMMENDATION.MIN_PASS_RATE_REJECT
    : DMARC_RECOMMENDATION.MIN_PASS_RATE;

  if (passRate < required) {
    return {
      ...base,
      recommendedPolicy: null,
      passRate,
      ready: false,
      reason: `${pct}% of messages pass DMARC — below the ${(required * 100).toFixed(1)}% needed for p=${target}. Fix the failing senders first; tightening now would stop their mail.`,
    };
  }

  if (stats.failingSources > 0) {
    // The rate can clear the bar while a low-volume legitimate sender fails
    // every message it sends. That sender is precisely who breaks on a
    // tightening, and it is invisible in the aggregate.
    return {
      ...base,
      recommendedPolicy: null,
      passRate,
      ready: false,
      reason: `${pct}% passing, but ${stats.failingSources} source(s) are still failing. Check they are not legitimate senders before moving to p=${target}.`,
    };
  }

  return {
    ...base,
    recommendedPolicy: target,
    passRate,
    ready: true,
    reason: `${pct}% of ${stats.totalMessages} message(s) passed over ${stats.windowDays} days with no failing sources — safe to move to p=${target}.`,
  };
}
