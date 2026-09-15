import { describe, it, expect, vi } from 'vitest';
import { isDigestible, dueDigests, renderDigest, type DigestMode } from './service.js';

describe('isDigestible — what may be delayed', () => {
  it('never delays anything when the user wants immediate delivery', () => {
    expect(isDigestible('mailbox.quota_threshold', 'immediate')).toBe(false);
  });

  it('delays ambient, record and action', () => {
    expect(isDigestible('admin.slo_alert_resolved', 'daily')).toBe(true);  // ambient
    expect(isDigestible('subscription.renewed', 'daily')).toBe(true);      // record
    expect(isDigestible('mailbox.quota_threshold', 'daily')).toBe(true);   // action
  });

  // A digest IS a delay, and these are the three classes that cannot absorb
  // one — the same rule that lets them through quiet hours.
  it('never delays incident, availability or security', () => {
    expect(isDigestible('admin.backup_failed', 'daily')).toBe(false);       // incident
    expect(isDigestible('admin.node_down', 'daily')).toBe(false);           // availability
    expect(isDigestible('security.password_reset', 'daily')).toBe(false);   // security
  });

  it('never delays the digest itself — batching the batch is how it stops arriving', () => {
    expect(isDigestible('platform.digest', 'daily')).toBe(false);
  });

  it('does not delay an unknown category rather than guessing', () => {
    expect(isDigestible('not.a.category', 'daily')).toBe(false);
  });
});

function db(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  return { select: () => chain } as never;
}

const item = (userId: string, minutesAgo: number, id = `i-${userId}-${minutesAgo}`) => ({
  id, userId, categoryId: 'subscription.renewed', subject: 's', body: 'b',
  createdAt: new Date(Date.now() - minutesAgo * 60_000),
});

describe('dueDigests — when a batch is ready', () => {
  const daily = (): DigestMode => 'daily';
  const hourly = (): DigestMode => 'hourly';

  it('holds an hourly batch that is not yet an hour old', async () => {
    expect(await dueDigests(db([item('u1', 30)]), hourly)).toEqual([]);
  });

  it('releases an hourly batch once the oldest item passes the window', async () => {
    const due = await dueDigests(db([item('u1', 61)]), hourly);
    expect(due).toHaveLength(1);
    expect(due[0].userId).toBe('u1');
  });

  it('holds a daily batch for a day, not an hour', async () => {
    expect(await dueDigests(db([item('u1', 120)]), daily)).toEqual([]);
  });

  // Measured from the OLDEST item, not the last flush: someone who gets one
  // notification a week should receive it a day later, not be held until
  // something else arrives to trigger a batch.
  it('measures the window from the oldest item', async () => {
    const due = await dueDigests(db([item('u1', 1500), item('u1', 5)]), daily);
    expect(due).toHaveLength(1);
    expect(due[0].items).toHaveLength(2);
  });

  it('groups per user and releases only the users who are due', async () => {
    const due = await dueDigests(db([item('u1', 1500), item('u2', 5)]), daily);
    expect(due.map((d) => d.userId)).toEqual(['u1']);
  });

  // A preference change must not orphan items already waiting.
  it('flushes immediately when the user turned the digest OFF while queued', async () => {
    const due = await dueDigests(db([item('u1', 5)]), () => 'immediate');
    expect(due).toHaveLength(1);
  });
});

describe('renderDigest', () => {
  it('uses the single subject when there is only one item', () => {
    expect(renderDigest([{ id: 'a', subject: 'Only one', body: 'b', categoryId: 'c' }]).subject)
      .toBe('Only one');
  });

  it('counts when there are several', () => {
    const r = renderDigest([
      { id: 'a', subject: 'First', body: 'b1', categoryId: 'c' },
      { id: 'b', subject: 'Second', body: 'b2', categoryId: 'c' },
    ]);
    expect(r.subject).toBe('2 notifications');
    expect(r.body).toContain('First');
    expect(r.body).toContain('Second');
  });
});
