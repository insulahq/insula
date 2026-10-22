import { describe, it, expect } from 'vitest';
import { updateSecuritySettingsSchema } from '@insula/api-contracts';
import { wafModeOf } from './settings-service.js';

// A route's WAF is one setting with three values. waf_enabled stays for an
// older client: on means enforced, as it always did.
describe('route WAF mode', () => {
  it('reads off / detection only / enforced from the two columns', () => {
    expect(wafModeOf({ wafEnabled: 0, wafDetectionOnly: 1 })).toBe('off');
    expect(wafModeOf({ wafEnabled: 1, wafDetectionOnly: 1 })).toBe('detection');
    expect(wafModeOf({ wafEnabled: 1, wafDetectionOnly: 0 })).toBe('enforced');
    expect(wafModeOf({ wafEnabled: 1 })).toBe('enforced');
  });

  it('the security update accepts waf_mode, and only its three values', () => {
    for (const m of ['off', 'detection', 'enforced']) {
      expect(updateSecuritySettingsSchema.safeParse({ waf_mode: m }).success).toBe(true);
    }
    const bad = updateSecuritySettingsSchema.safeParse({ waf_mode: 'monitor' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['waf_mode']);
  });
});

describe('updateSecuritySettings — waf_mode', () => {
  // Answers every read with one row (route and its domain alike) and records the update.
  function fakeDb() {
    const sets: Array<Record<string, unknown>> = [];
    const row = { id: 'r1', domainId: 'd1', tenantId: 't1', wafEnabled: 1, wafDetectionOnly: 0, forceHttps: 0, wafOwaspCrs: 0, hstsEnabled: 0, hstsIncludeSubdomains: 0, hstsPreload: 0 };
    const db = {
      select: () => ({ from: () => ({ where: async () => [row] }) }),
      update: () => ({ set: (v: Record<string, unknown>) => { sets.push(v); return { where: async () => undefined }; } }),
    };
    return { db: db as never, sets };
  }

  it('sets both columns from the mode', async () => {
    const { updateSecuritySettings } = await import('./settings-service.js');
    for (const [mode, want] of [['off', { wafEnabled: 0, wafDetectionOnly: 0 }], ['detection', { wafEnabled: 1, wafDetectionOnly: 1 }], ['enforced', { wafEnabled: 1, wafDetectionOnly: 0 }]] as const) {
      const { db, sets } = fakeDb();
      await updateSecuritySettings(db, 'r1', 't1', { waf_mode: mode });
      expect(sets[0]).toEqual(want);
    }
  });

  it('waf_enabled alone (an older client): on keeps the mode, off clears detection-only; waf_mode wins over it', async () => {
    const { updateSecuritySettings } = await import('./settings-service.js');
    const a = fakeDb();
    await updateSecuritySettings(a.db, 'r1', 't1', { waf_enabled: true });
    expect(a.sets[0]).toEqual({ wafEnabled: 1 });
    // Off-then-on through the old field must come back enforced, not as a dry run.
    const off = fakeDb();
    await updateSecuritySettings(off.db, 'r1', 't1', { waf_enabled: false });
    expect(off.sets[0]).toEqual({ wafEnabled: 0, wafDetectionOnly: 0 });
    const b = fakeDb();
    await updateSecuritySettings(b.db, 'r1', 't1', { waf_enabled: true, waf_mode: 'off' });
    expect(b.sets[0]).toEqual({ wafEnabled: 0, wafDetectionOnly: 0 });
  });
});
