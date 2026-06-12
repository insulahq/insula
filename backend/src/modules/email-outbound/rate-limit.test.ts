import { describe, it, expect, vi } from 'vitest';
import {
  buildEffectiveSendLimits,
  getEffectiveSendLimits,
  FALLBACK_HOURLY_LIMIT,
  FALLBACK_DAILY_LIMIT,
  type SendLimitRow,
} from './rate-limit.js';

function row(overrides: Partial<SendLimitRow> = {}): SendLimitRow {
  return {
    status: 'active',
    planId: 'plan-1',
    emailSendRateLimit: null,
    emailSendRateLimitDaily: null,
    emailOutboundSuspended: false,
    planCode: 'starter',
    planHourly: 50,
    planDaily: 100,
    ...overrides,
  };
}

describe('buildEffectiveSendLimits', () => {
  it('resolves plan values when no overrides exist', () => {
    const r = buildEffectiveSendLimits(row({ planHourly: 80, planDaily: 400 }));
    expect(r.hourly).toEqual({ limit: 80, source: 'plan' });
    expect(r.daily).toEqual({ limit: 400, source: 'plan' });
    expect(r.suspended).toBe(false);
    expect(r.outboundSuspended).toBe(false);
    // legacy keys
    expect(r.limitPerHour).toBe(80);
    expect(r.source).toBe('platform_default');
  });

  it('tenant override beats the plan, per window independently', () => {
    const r = buildEffectiveSendLimits(row({ emailSendRateLimit: 500 }));
    expect(r.hourly).toEqual({ limit: 500, source: 'tenant_override' });
    expect(r.daily).toEqual({ limit: 100, source: 'plan' });
    expect(r.limitPerHour).toBe(500);
    expect(r.source).toBe('tenant_override');
  });

  it('daily override works independently of hourly', () => {
    const r = buildEffectiveSendLimits(row({ emailSendRateLimitDaily: 5000 }));
    expect(r.hourly).toEqual({ limit: 50, source: 'plan' });
    expect(r.daily).toEqual({ limit: 5000, source: 'tenant_override' });
  });

  it('an override of 0 means blocked, not inherit', () => {
    const r = buildEffectiveSendLimits(row({ emailSendRateLimit: 0 }));
    expect(r.hourly).toEqual({ limit: 0, source: 'tenant_override' });
  });

  it('falls back to hardcoded defaults when the plan row is missing', () => {
    const r = buildEffectiveSendLimits(
      row({ planId: null, planCode: null, planHourly: null, planDaily: null }),
    );
    expect(r.hourly).toEqual({ limit: FALLBACK_HOURLY_LIMIT, source: 'fallback_default' });
    expect(r.daily).toEqual({ limit: FALLBACK_DAILY_LIMIT, source: 'fallback_default' });
    expect(r.source).toBe('hardcoded_default');
  });

  it('lifecycle suspension forces both windows to 0 and beats overrides', () => {
    const r = buildEffectiveSendLimits(
      row({ status: 'suspended', emailSendRateLimit: 500, emailSendRateLimitDaily: 5000 }),
    );
    expect(r.hourly).toEqual({ limit: 0, source: 'suspended' });
    expect(r.daily).toEqual({ limit: 0, source: 'suspended' });
    expect(r.suspended).toBe(true);
    expect(r.outboundSuspended).toBe(false);
    expect(r.limitPerHour).toBe(0);
    expect(r.source).toBe('suspended');
  });

  it('outbound suspension forces 0 with its own source', () => {
    const r = buildEffectiveSendLimits(
      row({ emailOutboundSuspended: true, emailSendRateLimit: 500 }),
    );
    expect(r.hourly).toEqual({ limit: 0, source: 'outbound_suspended' });
    expect(r.daily).toEqual({ limit: 0, source: 'outbound_suspended' });
    expect(r.outboundSuspended).toBe(true);
    expect(r.suspended).toBe(false);
    // legacy consumers see it as suspended
    expect(r.source).toBe('suspended');
  });

  it('exposes plan identity for the inspection endpoints', () => {
    const r = buildEffectiveSendLimits(row({ planId: 'p-9', planCode: 'business' }));
    expect(r.planId).toBe('p-9');
    expect(r.planCode).toBe('business');
  });
});

describe('getEffectiveSendLimits (DB path)', () => {
  function mockDb(rows: unknown[]) {
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    } as never;
  }

  it('throws TENANT_NOT_FOUND for an unknown tenant', async () => {
    await expect(getEffectiveSendLimits(mockDb([]), 'nope')).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
      status: 404,
    });
  });

  it('resolves through the joined plan row', async () => {
    const r = await getEffectiveSendLimits(
      mockDb([{
        status: 'active', planId: 'p1',
        emailSendRateLimit: null, emailSendRateLimitDaily: null,
        emailOutboundSuspended: false,
        planCode: 'biz', planHourly: 500, planDaily: 5000,
      }]),
      't1',
    );
    expect(r.hourly).toEqual({ limit: 500, source: 'plan' });
    expect(r.daily).toEqual({ limit: 5000, source: 'plan' });
    expect(r.planCode).toBe('biz');
  });
});
