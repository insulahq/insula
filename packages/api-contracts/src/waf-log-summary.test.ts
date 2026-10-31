import { describe, expect, it } from 'vitest';
import {
  patchWafLogSettingsRequestSchema,
  suggestWafExclusionScope,
  tenantWafLogSummaryQuerySchema,
} from './waf-log-summary.js';

describe('suggestWafExclusionScope', () => {
  it.each([
    ['920420', 'text_plain_as_json'],
    ['922130', 'full_disable'],
    ['920440', 'full_disable'],
    ['921110', 'full_disable'],
    ['911100', 'full_disable'],
    ['913100', 'full_disable'],
    ['941100', 'args'],
    ['932260', 'args'],
    ['930130', 'args'],
    ['942100', 'args'],
  ])('rule %s → %s', (rule, scope) => {
    expect(suggestWafExclusionScope(rule)).toBe(scope);
  });
});

describe('retention and summary requests', () => {
  it('retention is a whole number of days from 1 to 365', () => {
    for (const ok of [1, 30, 365]) expect(patchWafLogSettingsRequestSchema.safeParse({ retentionDays: ok }).success).toBe(true);
    for (const bad of [0, 366, 7.5, '30', null]) expect(patchWafLogSettingsRequestSchema.safeParse({ retentionDays: bad }).success).toBe(false);
  });

  it('the tenant summary window defaults to 7 days and stays within 1 hour to 30 days', () => {
    expect(tenantWafLogSummaryQuerySchema.parse({})).toEqual({ sinceSeconds: 604_800 });
    expect(tenantWafLogSummaryQuerySchema.parse({ sinceSeconds: '86400' }).sinceSeconds).toBe(86_400);
    for (const bad of ['60', String(31 * 86_400), 'x']) expect(tenantWafLogSummaryQuerySchema.safeParse({ sinceSeconds: bad }).success).toBe(false);
  });
});
