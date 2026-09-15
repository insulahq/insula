import { describe, it, expect, vi } from 'vitest';
import { isMutableCategory, MAX_MUTE_DAYS, MuteRejected, createMute } from './service.js';

function db() {
  return { execute: vi.fn().mockResolvedValue({ rows: [] }) } as never;
}

describe('isMutableCategory', () => {
  // The same rule that lets a class through quiet hours applies here: if it
  // can wait for a mute to expire, it was never one of those classes.
  it('refuses an incident category', () => {
    expect(isMutableCategory('admin.backup_failed')).toBe(false);
  });

  it('refuses an availability category', () => {
    expect(isMutableCategory('admin.node_down')).toBe(false);
  });

  it('refuses a security category', () => {
    expect(isMutableCategory('security.password_reset')).toBe(false);
  });

  it('allows an ambient category', () => {
    expect(isMutableCategory('admin.slo_alert_resolved')).toBe(true);
  });

  it('allows an action category', () => {
    expect(isMutableCategory('mailbox.quota_threshold')).toBe(true);
  });

  it('allows a category-wide mute (no category named)', () => {
    expect(isMutableCategory(null)).toBe(true);
  });

  it('allows an unknown category rather than guessing', () => {
    expect(isMutableCategory('not.a.real.category')).toBe(true);
  });
});

describe('createMute', () => {
  it('refuses a mandatory category with a message the API can surface', async () => {
    // Silently accepting a mute the dispatcher then ignores is worse than a
    // refusal: the operator believes they are quiet and they are not.
    await expect(createMute(db(), { categoryId: 'admin.node_down', objectKey: 'node-1', days: 1 }))
      .rejects.toThrow(MuteRejected);
  });

  it('refuses an indefinite mute', async () => {
    await expect(createMute(db(), { objectKey: 'node-1', days: 0 })).rejects.toThrow(/between 1 and/);
  });

  it(`refuses longer than ${MAX_MUTE_DAYS} days — beyond that it is a category toggle in disguise`, async () => {
    await expect(createMute(db(), { objectKey: 'node-1', days: MAX_MUTE_DAYS + 1 }))
      .rejects.toThrow(/between 1 and/);
  });

  it('accepts a scoped, expiring mute', async () => {
    const d = db();
    await expect(createMute(d, {
      categoryId: 'mailbox.quota_threshold',
      objectKey: 'user@example.test',
      days: 7,
      reason: 'migrating this mailbox',
    })).resolves.toBeUndefined();
    expect((d as unknown as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalled();
  });
});
