/**
 * The seeded plan ladder must differentiate CPU, not just price.
 *
 * `cpu_tier` is nullable, and a plan without one resolves to DEFAULT_TIER —
 * so a fresh install shipped Starter, Premium and Ultimate all competing at
 * the same scheduling weight. The ladder read as three tiers and behaved as
 * one, and nothing said so: the value is inert until a tenant is migrated
 * off `legacy`, by which time nobody is looking at the seed.
 *
 * Reads the source rather than the database: this is an assertion about
 * what we SHIP, and a test against a seeded database would pass on a
 * cluster whose operator had set the tiers by hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CPU_TIER_MILLICORES, type CpuTier } from '@insula/api-contracts';

const SRC = readFileSync(fileURLToPath(new URL('./seed.ts', import.meta.url)), 'utf8');

/**
 * The plan's whole object literal, brace-matched — not its first line.
 *
 * These rows are already 250 characters and nothing in the repo stops
 * someone wrapping one; a line-scoped match would then find `code:` and
 * `cpuTier:` on different lines and fail on a reformat that changed
 * nothing. Brace-MATCHED rather than regex-delimited because each row
 * nests a `features: { ... }` object, which a non-greedy `[^{}]*` cuts in
 * half and a greedy `.*` runs past into the next row.
 */
function planLiteral(code: string): string {
  const at = SRC.indexOf(`code: '${code}'`);
  if (at < 0) throw new Error(`no seeded plan '${code}'`);
  const open = SRC.lastIndexOf('{', at);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated literal for plan '${code}'`);
}
const tierOf = (code: string) => /cpuTier: '(\w+)'/.exec(planLiteral(code))?.[1] as CpuTier | undefined;
const cpuOf = (code: string) => Number(/cpuLimit: '([\d.]+)'/.exec(planLiteral(code))?.[1]);
const burstOf = (code: string) => Number(/cpuBurstCores: '([\d.]+)'/.exec(planLiteral(code))?.[1]);

describe('seeded hosting plans', () => {
  it.each([['starter', 'normal'], ['premium', 'high'], ['ultimate', 'highest']])(
    '%s sells the %s CPU tier', (code, tier) => {
      expect(tierOf(code)).toBe(tier);
    },
  );

  it('ascends: each plan up the ladder outranks the one below it', () => {
    const w = (code: string) => CPU_TIER_MILLICORES[tierOf(code)!];
    expect(w('starter')).toBeLessThan(w('premium'));
    expect(w('premium')).toBeLessThan(w('ultimate'));
  });

  /**
   * ★ DECLARED, not derived.
   *
   * Absent, the ceiling falls back to max(1, cpu_limit x 2) — the same
   * 1/2/4 ladder, but it keeps a TIERED tenant depending on `cpu_limit`,
   * the column the tier model exists to retire. ADR-062 says `cpu_limit`
   * is "unused by tiered mode"; while the fallback answers, that is false.
   */
  it('declares the burst ceiling instead of leaving it to derive', () => {
    expect([burstOf('starter'), burstOf('premium'), burstOf('ultimate')]).toEqual([1, 2, 4]);
  });

  it('declares the same ladder the derivation would have produced', () => {
    // So installing this release changes no tenant's ceiling — it only
    // stops the value depending on a column that is going away.
    const derived = ['starter', 'premium', 'ultimate'].map((c) => Math.max(1, cpuOf(c) * 2));
    expect(['starter', 'premium', 'ultimate'].map(burstOf)).toEqual(derived);
  });

  it('ascends with the ladder', () => {
    expect(burstOf('starter')).toBeLessThan(burstOf('premium'));
    expect(burstOf('premium')).toBeLessThan(burstOf('ultimate'));
  });
});
