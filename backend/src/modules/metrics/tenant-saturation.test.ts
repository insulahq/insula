import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../notifications/events.js', () => ({ notifyAdminTenantResourceSaturation: notify }));

import {
  saturationLevel,
  evaluateTenantSaturation,
  SATURATION_WARN,
  SATURATION_CRITICAL,
  STORAGE_SATURATION_CRITICAL,
} from './tenant-saturation.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = {} as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M = (cpu: [number, number], mem: [number, number], sto: [number, number]): any => ({
  cpu: { inUse: cpu[0], reserved: cpu[0], available: cpu[1] },
  memory: { inUse: mem[0], reserved: mem[0], available: mem[1] },
  storage: { inUse: sto[0], reserved: sto[0], available: sto[1] },
  lastUpdatedAt: '2026-07-22T00:00:00.000Z',
});

beforeEach(() => notify.mockReset());

describe('saturationLevel', () => {
  it('null below warn', () => {
    expect(saturationLevel(0, SATURATION_WARN, SATURATION_CRITICAL)).toBeNull();
    expect(saturationLevel(0.89, SATURATION_WARN, SATURATION_CRITICAL)).toBeNull();
    expect(saturationLevel(NaN, SATURATION_WARN, SATURATION_CRITICAL)).toBeNull();
  });
  it('warning between warn and crit', () => {
    expect(saturationLevel(0.9, SATURATION_WARN, SATURATION_CRITICAL)).toBe('warning');
    expect(saturationLevel(0.99, SATURATION_WARN, SATURATION_CRITICAL)).toBe('warning');
  });
  it('critical at/over crit', () => {
    expect(saturationLevel(1.0, SATURATION_WARN, SATURATION_CRITICAL)).toBe('critical');
    expect(saturationLevel(1.5, SATURATION_WARN, SATURATION_CRITICAL)).toBe('critical');
    // storage uses a lower critical (0.95)
    expect(saturationLevel(0.95, SATURATION_WARN, STORAGE_SATURATION_CRITICAL)).toBe('critical');
  });
});

describe('evaluateTenantSaturation', () => {
  it('fires CRITICAL for CPU at limit, nothing for healthy mem/storage', async () => {
    const fired = await evaluateTenantSaturation(db, 't1', 'Acme', M([2, 2], [1, 4], [5, 50]));
    expect(fired).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const [, level, payload, key] = notify.mock.calls[0];
    expect(level).toBe('critical');
    expect(payload).toMatchObject({ resource: 'CPU', usedPct: '100', limit: '2', unit: ' cores' });
    expect(key).toMatch(/^sat:t1:CPU:critical:\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  it('fires WARNING for memory at 90%', async () => {
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [3.6, 4], [5, 50]));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('warning');
    expect(notify.mock.calls[0][2]).toMatchObject({ resource: 'memory' });
  });

  it('fires storage critical at 95% (its lower crit threshold)', async () => {
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [47.5, 50]));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('critical');
    expect(notify.mock.calls[0][2]).toMatchObject({ resource: 'storage' });
  });

  it('skips dimensions with available <= 0 (unlimited/unknown)', async () => {
    await evaluateTenantSaturation(db, 't1', 'Acme', M([5, 0], [5, 0], [5, 0]));
    expect(notify).not.toHaveBeenCalled();
  });

  it('fires for multiple saturated dimensions at once', async () => {
    const fired = await evaluateTenantSaturation(db, 't1', 'Acme', M([2, 2], [4, 4], [1, 50]));
    expect(fired).toBe(2); // CPU + memory critical; storage healthy
  });
});
