/**
 * The quota contract must refuse what the COLUMN cannot hold.
 *
 * `memory_gb_limit`, `storage_gb_limit` and `bandwidth_gb_limit` are
 * `integer` in Postgres. Without `.int()` a request for 1.5 GB passed
 * validation and then failed inside the driver — `invalid input syntax for
 * type integer` — so an input the API had already declared it was checking
 * came back as a 500 with no field name on it.
 */
import { describe, it, expect } from 'vitest';
import { updateResourceQuotaSchema } from '@insula/api-contracts';

describe('updateResourceQuotaSchema', () => {
  it.each(['memory_gb_limit', 'storage_gb_limit', 'bandwidth_gb_limit'])(
    'refuses a fractional %s, which the integer column cannot hold', (field) => {
      const r = updateResourceQuotaSchema.safeParse({ [field]: 1.5 });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual([field]);
    },
  );

  it('accepts a whole number for each of them', () => {
    expect(updateResourceQuotaSchema.safeParse({
      memory_gb_limit: 2, storage_gb_limit: 20, bandwidth_gb_limit: 100,
    }).success).toBe(true);
  });

  it('still allows a FRACTIONAL cpu_cores_limit — that column is numeric(5,2)', () => {
    expect(updateResourceQuotaSchema.safeParse({ cpu_cores_limit: 0.25 }).success).toBe(true);
  });

  it('still refuses an unknown key rather than silently skipping it', () => {
    // The original point of this schema: a misspelled field used to be a
    // 200 that changed nothing.
    expect(updateResourceQuotaSchema.safeParse({ memory_limit_gb: 2 }).success).toBe(false);
  });

  it('refuses zero and negatives on every field', () => {
    for (const f of ['cpu_cores_limit', 'memory_gb_limit', 'storage_gb_limit', 'bandwidth_gb_limit']) {
      expect(updateResourceQuotaSchema.safeParse({ [f]: 0 }).success).toBe(false);
      expect(updateResourceQuotaSchema.safeParse({ [f]: -1 }).success).toBe(false);
    }
  });
});
