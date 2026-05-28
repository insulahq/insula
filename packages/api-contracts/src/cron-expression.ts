/**
 * 5-field cron expression validator (range-aware).
 *
 * Replaces the lax charset-only regex in cron-jobs.ts. Catches the kind
 * of operator typos that previously passed validation but produced
 * either zero fires or wildly wrong cadence:
 *   - "every 2 minutes"                       → freeform text
 *   - "STAR /10 * * * *" (extra space)        → 6 fields
 *   - "STAR/100 * * * *"                      → step exceeds 0-59 range
 *   - "60 * * * *"                            → minute 60 doesn't exist
 *   - "* * * 13 *"                            → month 13 doesn't exist
 *
 * Each field accepts:
 *   STAR                       any
 *   N                          single integer in field range
 *   A-B                        inclusive range, A ≤ B
 *   A-B / N                    range with step (N ≥ 1)
 *   STAR / N                   every N (1 ≤ N ≤ fieldMax)
 *   A,B,C   or  A-B,C-D        comma list of any of the above
 *
 * DOM and DOW alpha aliases (JAN-DEC, SUN-SAT, MON, etc.) are NOT
 * supported — k8s CronJob and most cron implementations accept them
 * but the Kubernetes API normalizes them anyway, and our internal
 * usage is always numeric. If we need them later, extend FIELD_NAMES.
 *
 * Returns null if valid, or a human-readable error string.
 */

import { z } from 'zod';

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const FIELDS: ReadonlyArray<FieldSpec> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 }, // both 0 and 7 = Sunday
];

function validateField(token: string, spec: FieldSpec): string | null {
  if (token === '') return `${spec.name}: empty`;
  // Comma-separated list — validate each part independently
  if (token.includes(',')) {
    for (const part of token.split(',')) {
      const err = validateField(part, spec);
      if (err) return err;
    }
    return null;
  }
  // Step form: *​/N or A-B/N or N/N
  let base = token;
  let stepStr: string | null = null;
  const slash = token.indexOf('/');
  if (slash >= 0) {
    base = token.slice(0, slash);
    stepStr = token.slice(slash + 1);
    if (stepStr === '' || !/^\d+$/.test(stepStr)) {
      return `${spec.name}: invalid step '${stepStr}' (expected positive integer)`;
    }
    const step = Number(stepStr);
    if (step < 1) return `${spec.name}: step must be ≥ 1`;
    if (step > spec.max) return `${spec.name}: step ${step} exceeds max ${spec.max}`;
  }
  // Base must be *, single int, or range A-B
  if (base === '*') return null;
  if (/^\d+$/.test(base)) {
    const n = Number(base);
    if (n < spec.min || n > spec.max) {
      return `${spec.name}: ${n} out of range [${spec.min}, ${spec.max}]`;
    }
    return null;
  }
  const rangeMatch = base.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    if (a < spec.min || a > spec.max) return `${spec.name}: range start ${a} out of range [${spec.min}, ${spec.max}]`;
    if (b < spec.min || b > spec.max) return `${spec.name}: range end ${b} out of range [${spec.min}, ${spec.max}]`;
    if (a > b) return `${spec.name}: range ${a}-${b} is empty (start > end)`;
    return null;
  }
  return `${spec.name}: '${base}' is not *, an integer, or a range`;
}

/** Returns null if valid, or a human-readable error message. */
export function validateCronExpression(expr: string): string | null {
  if (typeof expr !== 'string') return 'cron expression must be a string';
  const trimmed = expr.trim();
  if (trimmed === '') return 'cron expression is empty';
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return `cron expression must have 5 space-separated fields (minute hour day-of-month month day-of-week), got ${parts.length}`;
  }
  for (let i = 0; i < 5; i++) {
    const err = validateField(parts[i]!, FIELDS[i]!);
    if (err) return err;
  }
  return null;
}

/** Zod schema for a strictly-validated 5-field cron expression. */
export const cronExpressionSchema = z.string()
  .min(1, 'cron expression is required')
  .max(128, 'cron expression too long')
  .superRefine((value, ctx) => {
    const err = validateCronExpression(value);
    if (err) {
      ctx.addIssue({
        code: 'custom',
        message: err,
      });
    }
  });
