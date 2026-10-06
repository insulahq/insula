/**
 * Tenants table sorting: every column sorts by the value it SHOWS — numbers
 * numerically, placement by the node name on screen, dashes last.
 */
import { describe, it, expect } from 'vitest';
import { compareSortValues, sortRows } from '@/hooks/use-sortable';
import {
  instantSortValue,
  metricSortValue,
  placementSortValue,
  tenantSortAccessors,
} from '@/lib/tenant-list-sort';
import type { ResourceMetrics } from '@/hooks/use-resource-metrics';

function metrics(cpu: number | null, memory: number | null, storage: number | null): ResourceMetrics {
  const triple = (v: number | null) => ({ inUse: v, reserved: null, available: v === null ? null : 100 });
  return {
    tenantId: 'x',
    cpu: triple(cpu),
    memory: triple(memory),
    storage: triple(storage),
    lastUpdatedAt: '2026-10-01T00:00:00Z',
  } as unknown as ResourceMetrics;
}

const identity = (n: string): string => n;

describe('compareSortValues', () => {
  it('compares numbers numerically, not as text', () => {
    expect([10, 9, 100].sort(compareSortValues)).toEqual([9, 10, 100]);
  });

  it('compares numeric runs inside names numerically', () => {
    expect(['node-10', 'node-2', 'node-1'].sort(compareSortValues)).toEqual(['node-1', 'node-2', 'node-10']);
  });

  it('puts missing values after every value', () => {
    expect([null, 3, undefined, 1].sort(compareSortValues)).toEqual([1, 3, null, undefined]);
  });
});

describe('sortRows', () => {
  const rows = [{ id: 'a', n: 2 }, { id: 'b', n: 10 }, { id: 'c', n: 1 }];

  it('uses the accessor for a key that has one', () => {
    const sorted = sortRows(rows, 'derived', 'asc', { derived: (r) => -r.n });
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('falls back to the field and reverses for descending', () => {
    expect(sortRows(rows, 'n', 'desc').map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate its input', () => {
    const copy = [...rows];
    sortRows(rows, 'n', 'asc');
    expect(rows).toEqual(copy);
  });
});

describe('metricSortValue', () => {
  it('is the in-use figure the cell shows', () => {
    expect(metricSortValue(metrics(0.5, 200, 3000), 'cpu', 'active')).toBe(0.5);
    expect(metricSortValue(metrics(0.5, 200, 3000), 'memory', 'active')).toBe(200);
  });

  it('is null where the cell shows a dash: suspended, archived, no metrics, no reading', () => {
    expect(metricSortValue(metrics(1, 1, 1), 'cpu', 'suspended')).toBeNull();
    expect(metricSortValue(metrics(1, 1, 1), 'cpu', 'archived')).toBeNull();
    expect(metricSortValue(null, 'cpu', 'active')).toBeNull();
    expect(metricSortValue(metrics(null, 1, 1), 'cpu', 'active')).toBeNull();
  });
});

describe('placementSortValue', () => {
  const misplaced = {
    status: 'misplaced' as const, primaryNode: 'n1', actualNodes: ['n3'], reasons: [],
    misplacedSince: null, checkedAt: '2026-10-01T00:00:00Z',
  };

  it('is the node actually running the tenant when it is off its primary', () => {
    expect(placementSortValue({ nodeName: 'n1', placement: misplaced }, identity)).toBe('n3');
  });

  it('is the pinned node, by alias', () => {
    expect(placementSortValue({ nodeName: 'n1', placement: null }, (n) => `alias-${n}`)).toBe('alias-n1');
  });

  it('is null for an unpinned (auto) tenant', () => {
    expect(placementSortValue({ nodeName: null, placement: null }, identity)).toBeNull();
  });
});

describe('instantSortValue', () => {
  it('orders instants, and treats unset or garbage as no value', () => {
    expect(instantSortValue('2026-01-02T00:00:00Z')! > instantSortValue('2026-01-01T00:00:00Z')!).toBe(true);
    expect(instantSortValue(null)).toBeNull();
    expect(instantSortValue('not a date')).toBeNull();
  });
});

describe('tenantSortAccessors — whole table', () => {
  const tenants = [
    { id: 't1', name: 'Alpha', status: 'active' as const, nodeName: 'node-10', placement: null, storageTier: 'local' as const, planName: 'Pro', subscriptionExpiresAt: null },
    { id: 't2', name: 'Beta', status: 'active' as const, nodeName: 'node-2', placement: null, storageTier: 'ha' as const, planName: 'Basic', subscriptionExpiresAt: '2026-12-01T00:00:00Z' },
    { id: 't3', name: 'Gamma', status: 'suspended' as const, nodeName: null, placement: null, storageTier: undefined, planName: null, subscriptionExpiresAt: '2026-11-01T00:00:00Z' },
  ];
  const byId = { t1: metrics(2, 900, 50), t2: metrics(0.25, 4096, 10), t3: metrics(9, 9, 9) };
  const accessors = tenantSortAccessors<(typeof tenants)[number]>(byId, identity);
  const order = (key: string, dir: 'asc' | 'desc' = 'asc') => sortRows(tenants, key, dir, accessors).map((t) => t.id);

  it('sorts CPU / memory / storage numerically, a suspended tenant last', () => {
    expect(order('cpu')).toEqual(['t2', 't1', 't3']);
    expect(order('memory')).toEqual(['t1', 't2', 't3']);
    expect(order('storage')).toEqual(['t2', 't1', 't3']);
  });

  it('sorts placement by node name, auto last', () => {
    expect(order('placement')).toEqual(['t2', 't1', 't3']);
  });

  it('sorts tier, plan and expiry by what is shown', () => {
    expect(order('storageTier')).toEqual(['t2', 't1', 't3']); // HA, local, (missing → local)
    expect(order('planName')).toEqual(['t2', 't1', 't3']);
    expect(order('subscriptionExpiresAt')).toEqual(['t3', 't2', 't1']); // never last
  });

  it('reverses every column for descending', () => {
    expect(order('cpu', 'desc')).toEqual(['t3', 't1', 't2']);
  });
});
