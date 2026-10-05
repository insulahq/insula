import { describe, it, expect, vi } from 'vitest';
import { CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY } from '@insula/api-contracts';
import {
  failureEmailRecipients,
  failureEmailBucketKeys,
  resolveFailureEmailRecipients,
  type FailureEmailJob,
} from './failure-email.js';
import type { Database } from '../../db/index.js';

function job(overrides: Partial<FailureEmailJob> = {}): FailureEmailJob {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    notifyOnFailure: true,
    notifyTenantEmail: true,
    notifyEmail: null,
    ...overrides,
  };
}

/** A db whose only query is the tenant's primary email lookup. */
function tenantDb(primaryEmail: string | null): { db: Database; selects: number } {
  const state = { selects: 0 };
  const limit = vi.fn().mockImplementation(async () => (primaryEmail === null ? [] : [{ primaryEmail }]));
  const db = {
    select: vi.fn().mockImplementation(() => {
      state.selects += 1;
      return { from: () => ({ where: () => ({ limit }) }) };
    }),
  } as unknown as Database;
  return { db, get selects() { return state.selects; } };
}

/** An in-memory stand-in for the atomic notification rate-limit buckets. */
function memoryBuckets() {
  const counts = new Map<string, number>();
  const increment = vi.fn(async (_db: Database, key: string, _windowS: number, max: number) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { allowed: count <= max, remaining: Math.max(0, max - count), count, windowEnd: new Date() };
  });
  return { counts, increment };
}

describe('failureEmailRecipients', () => {
  it('is empty while the job has failure emails switched off', () => {
    expect(failureEmailRecipients(job({ notifyOnFailure: false, notifyEmail: 'ops@example.test' }), 'owner@example.test')).toEqual([]);
  });

  it('uses the tenant email only when ticked', () => {
    expect(failureEmailRecipients(job(), 'owner@example.test')).toEqual(['owner@example.test']);
    expect(failureEmailRecipients(job({ notifyTenantEmail: false, notifyEmail: 'ops@example.test' }), 'owner@example.test'))
      .toEqual(['ops@example.test']);
  });

  it('sends to both, once each, when the extra address is the tenant email in other case', () => {
    expect(failureEmailRecipients(job({ notifyEmail: 'ops@example.test' }), 'owner@example.test'))
      .toEqual(['owner@example.test', 'ops@example.test']);
    expect(failureEmailRecipients(job({ notifyEmail: ' Owner@Example.TEST ' }), 'owner@example.test'))
      .toEqual(['owner@example.test']);
  });

  it('is empty when the only recipient is a tenant email the tenant does not have', () => {
    expect(failureEmailRecipients(job(), null)).toEqual([]);
    expect(failureEmailRecipients(job(), '   ')).toEqual([]);
  });
});

describe('failureEmailBucketKeys', () => {
  it('buckets by UTC day, per job and per tenant', () => {
    const morning = failureEmailBucketKeys(job(), new Date('2026-10-05T00:00:01Z'));
    const night = failureEmailBucketKeys(job(), new Date('2026-10-05T23:59:59Z'));
    const nextDay = failureEmailBucketKeys(job(), new Date('2026-10-06T00:00:00Z'));
    expect(morning).toEqual(night);
    expect(nextDay.jobKey).not.toBe(morning.jobKey);
    expect(morning.jobKey).toContain('job-1');
    expect(morning.tenantKey).toContain('tenant-1');
    expect(morning.jobKey).not.toBe(morning.tenantKey);
  });

  it('ends in the window suffix the bucket store derives its window from', () => {
    const { jobKey, tenantKey } = failureEmailBucketKeys(job(), new Date('2026-10-05T12:00:00Z'));
    const dayStart = Date.UTC(2026, 9, 5) / 1000;
    expect(jobKey.endsWith(`:win:${dayStart}`)).toBe(true);
    expect(tenantKey.endsWith(`:win:${dayStart}`)).toBe(true);
    // notification_rate_limit_buckets.bucket_key is varchar(255).
    expect(jobKey.length).toBeLessThanOrEqual(255);
    expect(tenantKey.length).toBeLessThanOrEqual(255);
  });
});

describe('resolveFailureEmailRecipients', () => {
  const now = new Date('2026-10-05T12:00:00Z');

  it('does nothing at all — no lookup, no claim — when switched off', async () => {
    const t = tenantDb('owner@example.test');
    const buckets = memoryBuckets();
    const r = await resolveFailureEmailRecipients(t.db, job({ notifyOnFailure: false }), now, { increment: buckets.increment });
    expect(r).toEqual({ recipients: [], skipped: 'disabled' });
    expect(t.selects).toBe(0);
    expect(buckets.increment).not.toHaveBeenCalled();
  });

  it('resolves the tenant email from the tenant record at send time', async () => {
    const t = tenantDb('owner@example.test');
    const buckets = memoryBuckets();
    const r = await resolveFailureEmailRecipients(t.db, job({ notifyEmail: 'ops@example.test' }), now, { increment: buckets.increment });
    expect(r.recipients).toEqual(['owner@example.test', 'ops@example.test']);
    expect(r.skipped).toBeUndefined();
  });

  it('does not read the tenant when only the extra address is chosen', async () => {
    const t = tenantDb('owner@example.test');
    const buckets = memoryBuckets();
    const r = await resolveFailureEmailRecipients(
      t.db, job({ notifyTenantEmail: false, notifyEmail: 'ops@example.test' }), now, { increment: buckets.increment },
    );
    expect(r.recipients).toEqual(['ops@example.test']);
    expect(t.selects).toBe(0);
  });

  it('does not spend a slot when there is nobody to mail', async () => {
    const t = tenantDb(null);
    const buckets = memoryBuckets();
    const r = await resolveFailureEmailRecipients(t.db, job(), now, { increment: buckets.increment });
    expect(r).toEqual({ recipients: [], skipped: 'no-recipient' });
    expect(buckets.increment).not.toHaveBeenCalled();
  });

  it('mails a job failing every minute once per UTC day', async () => {
    const t = tenantDb('owner@example.test');
    const buckets = memoryBuckets();
    const sent: number[] = [];
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const at = new Date(Date.UTC(2026, 9, 5, 0, minute));
      const r = await resolveFailureEmailRecipients(t.db, job(), at, { increment: buckets.increment });
      if (r.recipients.length > 0) sent.push(minute);
      else expect(r.skipped).toBe('already-sent-today');
    }
    expect(sent).toEqual([0]);
    // The next UTC day it may mail again.
    const tomorrow = await resolveFailureEmailRecipients(t.db, job(), new Date('2026-10-06T00:00:30Z'), { increment: buckets.increment });
    expect(tomorrow.recipients).toEqual(['owner@example.test']);
  });

  it('caps a tenant with many failing jobs at the per-tenant daily limit', async () => {
    const t = tenantDb('owner@example.test');
    const buckets = memoryBuckets();
    let mailed = 0;
    let capped = 0;
    for (let i = 0; i < CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY + 15; i += 1) {
      const r = await resolveFailureEmailRecipients(
        t.db, job({ id: `job-${i}`, notifyEmail: 'victim@example.test' }), now, { increment: buckets.increment },
      );
      if (r.recipients.length > 0) mailed += 1;
      if (r.skipped === 'tenant-daily-cap') capped += 1;
    }
    expect(mailed).toBe(CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY);
    expect(capped).toBe(15);
    // Another tenant is unaffected by this one's cap.
    const other = await resolveFailureEmailRecipients(
      t.db, job({ id: 'job-x', tenantId: 'tenant-2' }), now, { increment: buckets.increment },
    );
    expect(other.recipients).toEqual(['owner@example.test']);
  });

  it('does not count an already-mailed job against the tenant cap', async () => {
    const t = tenantDb('owner@example.test');
    const buckets = memoryBuckets();
    for (let i = 0; i < 100; i += 1) {
      await resolveFailureEmailRecipients(t.db, job(), now, { increment: buckets.increment });
    }
    const { tenantKey } = failureEmailBucketKeys(job(), now);
    expect(buckets.counts.get(tenantKey)).toBe(1);
  });

  it('never throws — a failed lookup costs the email, not the in-panel notification', async () => {
    const db = {
      select: () => { throw new Error('db down'); },
    } as unknown as Database;
    const buckets = memoryBuckets();
    const r = await resolveFailureEmailRecipients(db, job(), now, { increment: buckets.increment });
    expect(r).toEqual({ recipients: [], skipped: 'error' });

    const failingBuckets = vi.fn().mockRejectedValue(new Error('bucket table locked'));
    const r2 = await resolveFailureEmailRecipients(tenantDb('owner@example.test').db, job(), now, { increment: failingBuckets });
    expect(r2).toEqual({ recipients: [], skipped: 'error' });
  });
});
