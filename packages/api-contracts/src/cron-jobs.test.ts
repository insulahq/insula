import { describe, it, expect } from 'vitest';
import {
  createCronJobSchema,
  updateCronJobSchema,
  CRON_TIMEOUT_MIN_SECONDS,
  CRON_TIMEOUT_MAX_SECONDS,
  DEFAULT_CRON_TIMEOUT_SECONDS,
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
