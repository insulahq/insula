import { describe, it, expect } from 'vitest';
import type { Tenant } from '@/types/api';
import type { Plan } from '@/hooks/use-plans';
import { buildLimitRows, diffDrafts, draftValue, effectOf, formatLimit, initialDraft, isRefused, type LimitRow } from './limits-model';

const PLAN = {
  id: 'p1', code: 'starter', name: 'Starter', description: null, status: 'active',
  cpuLimit: '1', cpuTier: null, cpuBurstCores: '2', memoryLimit: '2', storageLimit: '10',
  bandwidthGbLimit: 100, monthlyPriceUsd: '9.99', maxSubUsers: 3, maxMailboxes: 5, maxApplications: 2, maxMailboxSizeMb: 500,
  emailHourlySendLimit: 50, emailDailySendLimit: 500, allowCustomContainers: false,
} as unknown as Plan;

const tenant = (over: Partial<Record<string, unknown>> = {}) => ({ id: 't1', name: 'Acme', ...over }) as unknown as Tenant;
const ctx = { inUse: {}, cpuTiered: false };
const row = (rows: LimitRow[], id: LimitRow['id']) => rows.find((r) => r.id === id)!;

describe('buildLimitRows', () => {
  it('reads the plan value for a limit with no override, and the override when there is one', () => {
    const rows = buildLimitRows(tenant({ emailSendRateLimit: 10 }), PLAN, 'USD');
    expect(row(rows, 'mailboxes')).toMatchObject({ override: null, planValue: '5' });
    expect(row(rows, 'sendsHour')).toMatchObject({ override: '10', planValue: '50' });
  });

  it('keeps an override of 0 as a value, not as "no override"', () => {
    expect(row(buildLimitRows(tenant({ maxMailboxesOverride: 0 }), PLAN, 'USD'), 'mailboxes').override).toBe('0');
  });
});

describe('draftValue', () => {
  const rows = buildLimitRows(tenant(), PLAN, 'USD');
  it('sends null for a limit on the plan, and for an empty or blank Custom box', () => {
    expect(draftValue(row(rows, 'mailboxes'), { mode: 'plan', value: '7' })).toBeNull();
    expect(draftValue(row(rows, 'mailboxes'), { mode: 'custom', value: '' })).toBeNull();
    expect(draftValue(row(rows, 'mailboxes'), { mode: 'custom', value: '   ' })).toBeNull();
  });
  it('sends 0 as 0', () => {
    expect(draftValue(row(rows, 'mailboxes'), { mode: 'custom', value: '0' })).toBe(0);
  });
  it('marks a value that is not a number, or is negative, as invalid', () => {
    expect(draftValue(row(rows, 'mailboxes'), { mode: 'custom', value: 'abc' })).toBeUndefined();
    expect(draftValue(row(rows, 'mailboxes'), { mode: 'custom', value: '-1' })).toBeUndefined();
  });
  it('sends a tier as its name and a switch as a boolean', () => {
    expect(draftValue(row(rows, 'tier'), { mode: 'custom', value: 'high' })).toBe('high');
    expect(draftValue(row(rows, 'customContainers'), { mode: 'custom', value: 'true' })).toBe(true);
  });
});

describe('diffDrafts', () => {
  it('reads the numeric(p,2) strings the API returns as the numbers they are', () => {
    // The override columns are numeric(p,2): "20.00", not "20". Read raw, every
    // untouched custom limit compared unequal to its own box and was re-sent.
    const rows = buildLimitRows(tenant({ storageLimitOverride: '20.00', cpuLimitOverride: '0.50', monthlyPriceOverride: '9.90' }), PLAN, 'USD');
    const drafts = Object.fromEntries(rows.map((r) => [r.id, initialDraft(r)]));
    expect(diffDrafts(rows, drafts, ctx)).toEqual({ changes: [], payload: {}, invalid: [] });
    expect(diffDrafts(rows, { ...drafts, storage: { mode: 'custom', value: '20.0' } }, ctx).payload).toEqual({});
    expect(formatLimit(row(rows, 'storage'), row(rows, 'storage').override)).toBe('20 GB');
    expect(formatLimit(row(rows, 'price'), row(rows, 'price').override)).toBe('USD 9.90');
  });

  it('sends only what changed', () => {
    const rows = buildLimitRows(tenant({ emailSendRateLimit: 10 }), PLAN, 'USD');
    const drafts = Object.fromEntries(rows.map((r) => [r.id, initialDraft(r)]));
    expect(diffDrafts(rows, drafts, ctx).payload).toEqual({});
    const { payload, changes } = diffDrafts(rows, { ...drafts, mailboxes: { mode: 'custom', value: '0' } }, ctx);
    expect(payload).toEqual({ max_mailboxes_override: 0 });
    expect(changes).toEqual([expect.objectContaining({ id: 'mailboxes', from: '5 (plan)', to: '0', tone: 'warn' })]);
  });

  it('sends null when an override is put back on the plan', () => {
    const rows = buildLimitRows(tenant({ emailSendRateLimit: 10 }), PLAN, 'USD');
    const { payload, changes } = diffDrafts(rows, { sendsHour: { mode: 'plan', value: '10' } }, ctx);
    expect(payload).toEqual({ email_send_rate_limit: null });
    expect(changes[0]).toMatchObject({ from: '10 messages', to: '50 messages (plan)' });
  });

  it('lists an invalid box instead of sending it', () => {
    const rows = buildLimitRows(tenant(), PLAN, 'USD');
    const diff = diffDrafts(rows, { memory: { mode: 'custom', value: 'lots' } }, ctx);
    expect(diff.invalid).toEqual(['Memory']);
    expect(diff.payload).toEqual({});
  });

  it('refuses a storage limit below what is in use', () => {
    const rows = buildLimitRows(tenant({ storageLimitOverride: '20' }), PLAN, 'USD');
    const [c] = diffDrafts(rows, { storage: { mode: 'custom', value: '5' } }, { inUse: { storage: 8 }, cpuTiered: false }).changes;
    expect(isRefused(c!)).toBe(true);
    // A shrink that still fits is a confirm-separately change, not a refusal.
    const [fits] = diffDrafts(rows, { storage: { mode: 'custom', value: '12' } }, { inUse: { storage: 8 }, cpuTiered: false }).changes;
    expect(isRefused(fits!)).toBe(false);
  });
});

describe('effectOf', () => {
  const rows = buildLimitRows(tenant(), PLAN, 'USD');
  it('says a storage raise grows online and a cut shrinks with downtime', () => {
    expect(effectOf(row(rows, 'storage'), '10', '20', ctx)).toMatchObject({ tone: 'ok', effect: expect.stringContaining('online') });
    expect(effectOf(row(rows, 'storage'), '20', '10', ctx)).toMatchObject({ tone: 'bad', effect: expect.stringContaining('offline') });
  });
  it('says 0 sends blocks all outbound mail', () => {
    expect(effectOf(row(rows, 'sendsDay'), '500', '0', ctx)).toMatchObject({ tone: 'bad', effect: expect.stringContaining('blocks all outbound') });
  });
  it('says a tier change waits for Re-apply on a tiered tenant, and is not in effect on a legacy one', () => {
    expect(effectOf(row(rows, 'tier'), 'normal', 'high', { inUse: {}, cpuTiered: true }).effect).toContain('Re-apply');
    expect(effectOf(row(rows, 'tier'), 'normal', 'high', ctx).effect).toContain('not in effect');
  });
  it('warns when a mailbox limit drops below the mailboxes in use', () => {
    expect(effectOf(row(rows, 'mailboxes'), '5', '2', { inUse: { mailboxes: 4 }, cpuTiered: false })).toMatchObject({ tone: 'warn', effect: expect.stringContaining('4 mailboxes in use') });
  });
});

describe('the application limit', () => {
  it('reads the plan, and an override of 0 as a value', () => {
    expect(row(buildLimitRows(tenant(), PLAN, 'USD'), 'applications')).toMatchObject({ override: null, planValue: '2', field: 'max_applications_override' });
    expect(row(buildLimitRows(tenant({ maxApplicationsOverride: 0 }), PLAN, 'USD'), 'applications').override).toBe('0');
  });

  it('says what a lower limit does: nothing is stopped, nothing new is added', () => {
    const r = row(buildLimitRows(tenant(), PLAN, 'USD'), 'applications');
    expect(effectOf(r, '5', '0', ctx)).toMatchObject({ tone: 'warn', effect: expect.stringContaining('Existing ones keep running') });
    expect(effectOf(r, '5', '2', { ...ctx, inUse: { applications: 4 } }))
      .toMatchObject({ tone: 'warn', effect: expect.stringContaining('Below the 4 applications deployed') });
    expect(effectOf(r, '2', '5', { ...ctx, inUse: { applications: 4 } })).toMatchObject({ tone: 'ok' });
  });
});
