/**
 * The sweep that was missing. See the module header for why.
 */
import { describe, it, expect, vi } from 'vitest';
import { dropMaxCpu, sweepStaleLimitRangeMax } from './limitrange-sweep.js';

/** What the k8s JS client actually hands back: the ceiling as `_default`. */
const liveObject = () => ({
  metadata: { name: 'tenant-alpha-ns-cpu' },
  spec: {
    limits: [{
      type: 'Container',
      defaultRequest: { cpu: '5m' },
      _default: { cpu: '1' },
      max: { cpu: '1' },
    } as Record<string, unknown>],
  },
});

describe('dropMaxCpu', () => {
  it('removes the max that refused the platform’s own jobs', () => {
    const obj = liveObject();
    expect(dropMaxCpu(obj as never)).toBe(true);
    expect(obj.spec.limits[0].max).toBeUndefined();
  });

  it('KEEPS the ceiling, which is stored under the renamed key', () => {
    // The trap: rebuilding this object from its readable fields drops
    // `_default`, and every container in the namespace becomes unbounded —
    // the opposite of the protection the model promises. Mutating in place
    // is what preserves it, so this is the assertion that matters most.
    const obj = liveObject();
    dropMaxCpu(obj as never);
    expect(obj.spec.limits[0]._default).toEqual({ cpu: '1' });
    expect(obj.spec.limits[0].defaultRequest).toEqual({ cpu: '5m' });
  });

  it('is idempotent and reports no change on an already-clean range', () => {
    const obj = liveObject();
    dropMaxCpu(obj as never);
    expect(dropMaxCpu(obj as never)).toBe(false);
  });

  it('leaves a non-Container limit alone', () => {
    const obj = { spec: { limits: [{ type: 'Pod', max: { cpu: '4' } }] } };
    expect(dropMaxCpu(obj as never)).toBe(false);
    expect(obj.spec.limits[0].max).toEqual({ cpu: '4' });
  });
});

describe('sweepStaleLimitRangeMax', () => {
  const db = (namespaces: string[]) => ({
    select: () => ({ from: () => ({ where: () => Promise.resolve(namespaces.map((ns) => ({ ns }))) }) }),
  }) as never;

  it('rewrites only the namespaces that carry a max', async () => {
    const withMax = new Set(['tenant-alpha-ns', 'tenant-gamma-ns']);
    const replaced: string[] = [];
    const res = await sweepStaleLimitRangeMax(
      db(['tenant-alpha-ns', 'tenant-beta-ns', 'tenant-gamma-ns']),
      {
        read: async (ns) => (withMax.has(ns)
          ? liveObject() as never
          : { spec: { limits: [{ type: 'Container', _default: { cpu: '1' } }] } } as never),
        replace: async (ns) => { replaced.push(ns); },
      },
    );
    expect(res.scanned).toBe(3);
    expect(res.stripped).toEqual(['tenant-alpha-ns', 'tenant-gamma-ns']);
    expect(replaced).toEqual(['tenant-alpha-ns', 'tenant-gamma-ns']);
  });

  it('one unreachable namespace does not stop the rest', async () => {
    const res = await sweepStaleLimitRangeMax(
      db(['tenant-alpha-ns', 'tenant-beta-ns']),
      {
        read: async (ns) => {
          if (ns === 'tenant-alpha-ns') throw new Error('boom');
          return liveObject() as never;
        },
        replace: vi.fn(async () => {}),
      },
    );
    expect(res.failed).toEqual(['tenant-alpha-ns']);
    expect(res.stripped).toEqual(['tenant-beta-ns']);
  });

  it('a namespace with no LimitRange is skipped, not an error', async () => {
    const res = await sweepStaleLimitRangeMax(db(['tenant-alpha-ns']), {
      read: async () => null,
      replace: async () => { throw new Error('must not write'); },
    });
    expect(res.stripped).toEqual([]);
    expect(res.failed).toEqual([]);
  });
});
