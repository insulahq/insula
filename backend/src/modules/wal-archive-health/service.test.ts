import { describe, it, expect, vi } from 'vitest';
import { parseStorageQuantity, readWalArchiveHealth, type ReadWalArchiveDeps } from './service.js';

describe('parseStorageQuantity', () => {
  it('parses binary (Ki/Mi/Gi/Ti/Pi/Ei) units', () => {
    expect(parseStorageQuantity('20Gi')).toBe(20 * 1024 ** 3);
    expect(parseStorageQuantity('500Mi')).toBe(500 * 1024 ** 2);
    expect(parseStorageQuantity('1Ki')).toBe(1024);
    expect(parseStorageQuantity('1Ti')).toBe(1024 ** 4);
    expect(parseStorageQuantity('1Ei')).toBe(1024 ** 6);
  });

  it('parses decimal SI (K/M/G/T/P/E) units', () => {
    expect(parseStorageQuantity('1G')).toBe(1e9);
    expect(parseStorageQuantity('2T')).toBe(2e12);
    expect(parseStorageQuantity('1E')).toBe(1e18);
  });

  it('parses a bare byte count', () => {
    expect(parseStorageQuantity('1000000000')).toBe(1_000_000_000);
  });

  it('handles decimals', () => {
    expect(parseStorageQuantity('1.5Gi')).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it('returns 0 for empty / undefined / malformed input', () => {
    expect(parseStorageQuantity(undefined)).toBe(0);
    expect(parseStorageQuantity('')).toBe(0);
    expect(parseStorageQuantity('garbage')).toBe(0);
    expect(parseStorageQuantity('20Zi')).toBe(0);
  });
});

describe('readWalArchiveHealth: when archiving started failing', () => {
  const deps = (condition: Record<string, string> | null): ReadWalArchiveDeps => ({
    db: { execute: vi.fn(async () => ({ rows: [{ wal_bytes: '1024' }] })) } as unknown as ReadWalArchiveDeps['db'],
    custom: {
      getNamespacedCustomObject: vi.fn(async () => ({
        spec: { plugins: [{ name: 'barman-cloud.cloudnative-pg.io' }], storage: { size: '4Gi' } },
        status: { conditions: condition ? [{ type: 'ContinuousArchiving', ...condition }] : [] },
      })),
    } as unknown as ReadWalArchiveDeps['custom'],
    log: { warn: vi.fn() },
  });

  it('takes the start from the condition while it is False', async () => {
    const s = await readWalArchiveHealth(deps({ status: 'False', lastTransitionTime: '2026-11-03T16:30:45Z' }));
    expect(s?.continuousArchivingHealthy).toBe(false);
    expect(s?.failingSince).toBe('2026-11-03T16:30:45Z');
  });

  it('has no start while archiving is healthy (that transition is when it recovered)', async () => {
    const s = await readWalArchiveHealth(deps({ status: 'True', lastTransitionTime: '2026-11-03T16:30:51Z' }));
    expect(s?.continuousArchivingHealthy).toBe(true);
    expect(s?.continuousArchivingConfirmed).toBe(true);
    expect(s?.failingSince).toBeNull();
  });

  it('counts an Unknown or absent condition as not failing, but not as working', async () => {
    for (const s of [await readWalArchiveHealth(deps({ status: 'Unknown' })), await readWalArchiveHealth(deps(null))]) {
      expect(s?.continuousArchivingHealthy).toBe(true);
      expect(s?.continuousArchivingConfirmed).toBe(false);
    }
  });

  it('has no start when CNPG gave no time', async () => {
    const s = await readWalArchiveHealth(deps({ status: 'False' }));
    expect(s?.continuousArchivingHealthy).toBe(false);
    expect(s?.failingSince).toBeNull();
  });
});
