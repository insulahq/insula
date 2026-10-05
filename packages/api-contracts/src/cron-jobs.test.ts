import { describe, it, expect } from 'vitest';
import {
  createCronJobSchema,
  updateCronJobSchema,
  CRON_TIMEOUT_MIN_SECONDS,
  CRON_TIMEOUT_MAX_SECONDS,
  DEFAULT_CRON_TIMEOUT_SECONDS,
  CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY,
  cronJobResponseSchema,
  cronFailureEmailInfoSchema,
  failureEmailRecipientMissing,
} from './cron-jobs.js';

const base = {
  name: 'Moodle cron',
  type: 'deployment' as const,
  schedule: '* * * * *',
  command: 'php /var/www/html/admin/cli/cron.php',
  deployment_id: '11111111-2222-4333-8444-555555555555',
};

describe('cron job timeout_seconds', () => {
  it('is optional — an existing caller that omits it still parses', () => {
    const parsed = createCronJobSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.timeout_seconds).toBeUndefined();
  });

  it('accepts a value a long-running application cron actually needs', () => {
    // Moodle's admin/cli/cron.php took 182 s on a freshly installed site, and
    // longer with a course backup — 900 s is a realistic setting, and the old
    // fixed 300 s ceiling is what made this field necessary.
    const parsed = createCronJobSchema.safeParse({ ...base, timeout_seconds: 900 });
    expect(parsed.success).toBe(true);
  });

  it('refuses a value below the floor or above the hour cap', () => {
    expect(createCronJobSchema.safeParse({ ...base, timeout_seconds: 0 }).success).toBe(false);
    expect(createCronJobSchema.safeParse({ ...base, timeout_seconds: CRON_TIMEOUT_MIN_SECONDS - 1 }).success).toBe(false);
    expect(createCronJobSchema.safeParse({ ...base, timeout_seconds: CRON_TIMEOUT_MAX_SECONDS + 1 }).success).toBe(false);
  });

  it('refuses a fractional value — this is whole seconds', () => {
    expect(createCronJobSchema.safeParse({ ...base, timeout_seconds: 30.5 }).success).toBe(false);
  });

  it('can be changed on an existing job', () => {
    const parsed = updateCronJobSchema.safeParse({ timeout_seconds: 600 });
    expect(parsed.success).toBe(true);
  });

  it('keeps the two per-type defaults far apart, on purpose', () => {
    // A webcron ping that needs 30 s is broken; an application cron that only
    // gets 30 s is cut off. One number cannot serve both.
    expect(DEFAULT_CRON_TIMEOUT_SECONDS.webcron).toBe(30);
    expect(DEFAULT_CRON_TIMEOUT_SECONDS.deployment).toBe(300);
    expect(DEFAULT_CRON_TIMEOUT_SECONDS.deployment).toBeGreaterThan(DEFAULT_CRON_TIMEOUT_SECONDS.webcron);
    // Both defaults must sit inside the range the API will accept, or a job
    // could not be edited to its own default.
    for (const v of Object.values(DEFAULT_CRON_TIMEOUT_SECONDS)) {
      expect(v).toBeGreaterThanOrEqual(CRON_TIMEOUT_MIN_SECONDS);
      expect(v).toBeLessThanOrEqual(CRON_TIMEOUT_MAX_SECONDS);
    }
  });
});

/**
 * The edit form can clear a field. "Cleared" and "not touched" are different
 * intents and must not share a wire representation: an omitted key leaves the
 * stored value alone, so without an explicit null a job pinned to 600s or to
 * Europe/Berlin could never be put back on the platform default.
 */
describe('updateCronJobSchema: clearing a pinned field', () => {
  it('accepts null for timeout_seconds — back to the per-type default', () => {
    const parsed = updateCronJobSchema.safeParse({ timeout_seconds: null });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.timeout_seconds).toBeNull();
  });

  it('accepts null for timezone — back to the platform clock', () => {
    const parsed = updateCronJobSchema.safeParse({ timezone: null });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.timezone).toBeNull();
  });

  it('still distinguishes omitted from cleared', () => {
    const omitted = updateCronJobSchema.parse({ name: 'x' });
    expect('timeout_seconds' in omitted && omitted.timeout_seconds !== undefined).toBe(false);
    expect(updateCronJobSchema.parse({ timeout_seconds: null }).timeout_seconds).toBeNull();
  });

  it('does not loosen the range — null is the only non-number allowed', () => {
    expect(updateCronJobSchema.safeParse({ timeout_seconds: 0 }).success).toBe(false);
    expect(updateCronJobSchema.safeParse({ timeout_seconds: CRON_TIMEOUT_MAX_SECONDS + 1 }).success).toBe(false);
    expect(updateCronJobSchema.safeParse({ timezone: 'Mars/Olympus_Mons' }).success).toBe(false);
  });

  // Flipping type would leave a row holding both a url and a command with
  // nothing to say which the scheduler should honour.
  it('refuses to change a job between webcron and deployment', () => {
    const parsed = updateCronJobSchema.parse({ type: 'webcron', name: 'x' } as never);
    expect('type' in parsed).toBe(false);
  });
});

/**
 * Failure emails are opt-in per job. The platform sends mail to an address the
 * tenant typed in, so the contract is strict about what an address is and
 * refuses a switched-on notification that names nobody.
 */
describe('cron job failure emails', () => {
  const webcron = {
    name: 'Nightly ping',
    type: 'webcron' as const,
    schedule: '0 3 * * *',
    url: 'https://example.test/cron.php',
  };

  it('is off by default on create, with the tenant email pre-selected', () => {
    const parsed = createCronJobSchema.parse(webcron);
    expect(parsed.notify_on_failure).toBe(false);
    expect(parsed.notify_tenant_email).toBe(true);
    expect(parsed.notify_email ?? null).toBeNull();
  });

  it('accepts the tenant email alone, an extra address alone, or both', () => {
    expect(createCronJobSchema.safeParse({ ...webcron, notify_on_failure: true }).success).toBe(true);
    expect(createCronJobSchema.safeParse({
      ...webcron, notify_on_failure: true, notify_tenant_email: false, notify_email: 'ops@example.test',
    }).success).toBe(true);
    expect(createCronJobSchema.safeParse({
      ...webcron, notify_on_failure: true, notify_email: 'ops@example.test',
    }).success).toBe(true);
  });

  it('refuses a switched-on notification with no recipient, naming the field', () => {
    const parsed = createCronJobSchema.safeParse({
      ...webcron, notify_on_failure: true, notify_tenant_email: false,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(['notify_email']);
      expect(parsed.error.issues[0].message).toMatch(/recipient/i);
    }
  });

  it('does not demand a recipient while the notification is off', () => {
    expect(createCronJobSchema.safeParse({
      ...webcron, notify_on_failure: false, notify_tenant_email: false,
    }).success).toBe(true);
  });

  it('refuses something that is not an email address', () => {
    for (const bad of ['not-an-address', 'ops@', 'ops@example', 'a@b.c\r\nBcc: x@example.test']) {
      expect(createCronJobSchema.safeParse({ ...webcron, notify_email: bad }).success).toBe(false);
      expect(updateCronJobSchema.safeParse({ notify_email: bad }).success).toBe(false);
    }
  });

  it('trims the address and caps its length', () => {
    const parsed = createCronJobSchema.parse({ ...webcron, notify_email: '  ops@example.test ' });
    expect(parsed.notify_email).toBe('ops@example.test');
    const long = `${'a'.repeat(250)}@example.test`;
    expect(createCronJobSchema.safeParse({ ...webcron, notify_email: long }).success).toBe(false);
  });

  it('lets an edit clear the extra address with null and leaves omitted fields alone', () => {
    expect(updateCronJobSchema.parse({ notify_email: null }).notify_email).toBeNull();
    const omitted = updateCronJobSchema.parse({ name: 'x' });
    expect(omitted.notify_on_failure).toBeUndefined();
    expect(omitted.notify_tenant_email).toBeUndefined();
    expect(omitted.notify_email).toBeUndefined();
  });

  it('exposes the three settings on the response', () => {
    const shape = cronJobResponseSchema.shape;
    expect(shape.notifyOnFailure).toBeDefined();
    expect(shape.notifyTenantEmail).toBeDefined();
    expect(shape.notifyEmail).toBeDefined();
  });

  it('caps failure emails per tenant per day at a small positive number', () => {
    expect(CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY).toBeGreaterThan(0);
    expect(CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY).toBeLessThanOrEqual(50);
    expect(cronFailureEmailInfoSchema.safeParse({
      tenantEmail: 'owner@example.test', maxEmailsPerTenantPerDay: CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY,
    }).success).toBe(true);
  });
});

describe('failureEmailRecipientMissing', () => {
  // One rule, shared by the API (which validates the MERGED row on edit) and
  // both panels (which disable Save) — so they cannot disagree.
  it('is only ever true when the notification is on and names nobody', () => {
    expect(failureEmailRecipientMissing({ notifyOnFailure: false, notifyTenantEmail: false, notifyEmail: null })).toBe(false);
    expect(failureEmailRecipientMissing({ notifyOnFailure: true, notifyTenantEmail: true, notifyEmail: null })).toBe(false);
    expect(failureEmailRecipientMissing({ notifyOnFailure: true, notifyTenantEmail: false, notifyEmail: 'ops@example.test' })).toBe(false);
    expect(failureEmailRecipientMissing({ notifyOnFailure: true, notifyTenantEmail: false, notifyEmail: null })).toBe(true);
    expect(failureEmailRecipientMissing({ notifyOnFailure: true, notifyTenantEmail: false, notifyEmail: '   ' })).toBe(true);
  });
});
