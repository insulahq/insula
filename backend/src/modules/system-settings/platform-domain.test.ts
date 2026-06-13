import { describe, it, expect, vi } from 'vitest';

// eq(col, val) → capture the looked-up key so the mock db can branch on it.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _key: val })),
}));
vi.mock('../../db/schema.js', () => ({
  platformSettings: { key: 'setting_key', value: 'setting_value' },
}));

const { getPlatformApex } = await import('./platform-domain.js');

// A mock db whose KV select returns the configured value for the queried key.
function mockDb(kv: Record<string, string | undefined>) {
  return {
    select: () => ({
      from: () => ({
        where: (cond: { _key?: string }) => {
          const v = kv[cond._key ?? ''];
          return Promise.resolve(v !== undefined ? [{ value: v }] : []);
        },
      }),
    }),
  } as never;
}

describe('getPlatformApex', () => {
  it('returns platform_domain when set', async () => {
    const db = mockDb({ platform_domain: 'brand.example', ingress_base_domain: 'ingress.example' });
    expect(await getPlatformApex(db)).toBe('brand.example');
  });

  it('falls back to ingress_base_domain when platform_domain is unset (back-compat)', async () => {
    const db = mockDb({ ingress_base_domain: 'ingress.example' });
    expect(await getPlatformApex(db)).toBe('ingress.example');
  });

  it('falls back when platform_domain is empty/whitespace', async () => {
    const db = mockDb({ platform_domain: '   ', ingress_base_domain: 'ingress.example' });
    expect(await getPlatformApex(db)).toBe('ingress.example');
  });

  it('returns null when neither is set', async () => {
    const db = mockDb({});
    expect(await getPlatformApex(db)).toBeNull();
  });

  it('strips trailing dots', async () => {
    const db = mockDb({ platform_domain: 'brand.example.' });
    expect(await getPlatformApex(db)).toBe('brand.example');
  });
});
