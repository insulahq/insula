import { describe, it, expect, vi } from 'vitest';
import {
  isEscalatable,
  findEscalationCandidates,
  describeCandidates,
  ESCALATE_AFTER_HOURS,
} from './service.js';

describe('isEscalatable — what is worth chasing', () => {
  it('escalates action, which is the class that asks for something', () => {
    expect(isEscalatable('mailbox.quota_threshold')).toBe(true);
    expect(isEscalatable('subscription.expiry_warning')).toBe(true);
  });

  // Ambient and Record ask for nothing, so there is nothing to chase.
  it('does not escalate ambient or record', () => {
    expect(isEscalatable('admin.slo_alert_resolved')).toBe(false);
    expect(isEscalatable('subscription.renewed')).toBe(false);
  });

  // These already reach every channel the audience has at the moment they
  // fire. There is no higher level; escalating would just send a second copy.
  it('does not escalate incident, availability or security', () => {
    expect(isEscalatable('admin.backup_failed')).toBe(false);
    expect(isEscalatable('admin.node_down')).toBe(false);
    expect(isEscalatable('security.password_reset')).toBe(false);
  });

  it('reads the CLASS, not the severity', () => {
    // subscription.expiry_warning is severity=warning and class=action -> chase.
    // admin.slo_alert_critical is severity=critical and class=incident -> do not.
    expect(isEscalatable('subscription.expiry_warning')).toBe(true);
    expect(isEscalatable('admin.slo_alert_critical')).toBe(false);
  });

  it('ignores an uncategorised row rather than guessing', () => {
    expect(isEscalatable(null)).toBe(false);
    expect(isEscalatable('not.a.category')).toBe(false);
  });
});

function db(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as never;
}

const row = (categoryId: string, daysAgo = 3) => ({
  id: `n-${categoryId}`,
  userId: 'u1',
  categoryId,
  title: `${categoryId} title`,
  message: 'm',
  createdAt: new Date(Date.now() - daysAgo * 86_400_000),
});

describe('findEscalationCandidates', () => {
  it('keeps only the escalatable categories', async () => {
    const out = await findEscalationCandidates(db([
      row('mailbox.quota_threshold'),
      row('subscription.renewed'),     // record
      row('admin.backup_failed'),      // incident
    ]));
    expect(out.map((c) => c.categoryId)).toEqual(['mailbox.quota_threshold']);
  });

  it('returns nothing when everything unread is un-chaseable', async () => {
    expect(await findEscalationCandidates(db([row('admin.slo_alert_resolved')]))).toEqual([]);
  });

  it(`uses a ${ESCALATE_AFTER_HOURS}h deadline`, () => {
    expect(ESCALATE_AFTER_HOURS).toBe(48);
  });
});

describe('describeCandidates', () => {
  it('names each notification and how long it has been sitting', () => {
    const s = describeCandidates([row('mailbox.quota_threshold') as never]);
    expect(s).toContain('mailbox.quota_threshold title');
    expect(s).toMatch(/unread since \d{4}-\d{2}-\d{2}/);
  });

  it('caps the summary so one bad day cannot produce an unbounded body', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...row('mailbox.quota_threshold'), id: `n${i}`, title: `Notification number ${i}`,
    }));
    expect(describeCandidates(many as never).length).toBeLessThanOrEqual(2000);
  });
});
