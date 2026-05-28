import { describe, it, expect } from 'vitest';
import { validateCronExpression, cronExpressionSchema } from './cron-expression.js';

describe('validateCronExpression', () => {
  it.each([
    '* * * * *',
    '*/2 * * * *',
    '*/10 * * * *',
    '0 */6 * * *',
    '30 4 * * 0',
    '15 2 1 * *',
    '0 0 1 1 *',
    '0 0 1 1 0',
    '0 0 1 1 7',           // 7 = Sunday alias
    '0,15,30,45 * * * *',
    '0-30/5 * * * *',
    '* * 1-15 * *',
    '* * * 1-12 *',
  ])('accepts valid expression %q', (expr) => {
    expect(validateCronExpression(expr)).toBeNull();
  });

  it.each<[string, string]>([
    ['',                       'empty'],
    ['hello',                  '5 space-separated fields'],
    ['* * * *',                '5 space-separated'],     // 4 fields
    ['* * * * * *',            '5 space-separated'],     // 6 fields
    ['60 * * * *',             'out of range'],           // minute > 59
    ['* 24 * * *',             'out of range'],           // hour > 23
    ['* * 0 * *',              'out of range'],           // DOM < 1
    ['* * 32 * *',             'out of range'],           // DOM > 31
    ['* * * 13 *',             'out of range'],           // month > 12
    ['* * * 0 *',              'out of range'],           // month < 1
    ['* * * * 8',              'out of range'],           // DOW > 7
    ['*/0 * * * *',            'step must be ≥ 1'],
    ['*/100 * * * *',          'exceeds max'],
    ['10-5 * * * *',           'range'],                  // a > b
    ['abc * * * *',            'not *, an integer, or a range'],
    ['*/abc * * * *',          'invalid step'],
    [' ',                      'empty'],
    ['* * * * /5',             'not *, an integer'],     // trailing /5 in 5th field
  ])('rejects %q with reason containing %q', (expr, fragment) => {
    const err = validateCronExpression(expr);
    expect(err, `expected error for "${expr}"`).not.toBeNull();
    expect(err).toContain(fragment);
  });
});

describe('cronExpressionSchema', () => {
  it('accepts valid expressions', () => {
    expect(cronExpressionSchema.safeParse('*/10 * * * *').success).toBe(true);
    expect(cronExpressionSchema.safeParse('0 4 * * 0').success).toBe(true);
  });

  it('rejects invalid expressions with a useful message', () => {
    const r1 = cronExpressionSchema.safeParse('hello world');
    expect(r1.success).toBe(false);
    if (!r1.success) {
      expect(r1.error.issues[0]!.message).toContain('5 space-separated fields');
    }
    const r2 = cronExpressionSchema.safeParse('60 * * * *');
    expect(r2.success).toBe(false);
    if (!r2.success) {
      expect(r2.error.issues[0]!.message).toContain('out of range');
    }
  });

  it('enforces 1-128 char length', () => {
    expect(cronExpressionSchema.safeParse('').success).toBe(false);
    expect(cronExpressionSchema.safeParse('a'.repeat(200)).success).toBe(false);
  });
});
