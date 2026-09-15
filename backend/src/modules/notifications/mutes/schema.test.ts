import { describe, it, expect } from 'vitest';
import { createNotificationMuteSchema, MAX_MUTE_DAYS } from '@insula/api-contracts';

/**
 * These assertions exist because the first version of the mute routes CAST
 * `request.body` instead of parsing it, and Backend CI's R29a guard caught it.
 * A cast reads a misspelled field as `undefined`, skips whatever it controlled
 * and returns 200 — and for a mute that means the operator believes they are
 * quiet when nothing was muted at all.
 */
describe('createNotificationMuteSchema', () => {
  it('accepts a well-formed mute', () => {
    const r = createNotificationMuteSchema.safeParse({
      categoryId: 'mailbox.quota_threshold', objectKey: 'user@example.test', days: 7,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a missing objectKey instead of muting nothing and returning 200', () => {
    expect(createNotificationMuteSchema.safeParse({ days: 7 }).success).toBe(false);
  });

  it('rejects a non-numeric days', () => {
    expect(createNotificationMuteSchema.safeParse({ objectKey: 'k', days: '7' }).success).toBe(false);
  });

  it('rejects an indefinite mute at the contract boundary, not just in the service', () => {
    expect(createNotificationMuteSchema.safeParse({ objectKey: 'k', days: 0 }).success).toBe(false);
    expect(createNotificationMuteSchema.safeParse({ objectKey: 'k', days: MAX_MUTE_DAYS + 1 }).success).toBe(false);
  });

  // .strict() on purpose: Zod STRIPS unknown keys by default, so a caller who
  // misspells a field gets a 200 and a mute that does not do what they asked.
  it('rejects an unknown key rather than silently stripping it', () => {
    const r = createNotificationMuteSchema.safeParse({
      objectKey: 'k', days: 7, catagoryId: 'typo.here',
    });
    expect(r.success).toBe(false);
  });

  it('allows a category-wide mute with an absent categoryId', () => {
    expect(createNotificationMuteSchema.safeParse({ objectKey: 'k', days: 7 }).success).toBe(true);
  });
});
