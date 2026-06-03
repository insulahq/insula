import { describe, it, expect } from 'vitest';
import { convergeModules, moduleNameValid } from './modules.js';
import type { ModuleDeps, ModuleSpec } from './types.js';

function fakeDeps(loaded: string[] = []): { deps: ModuleDeps; loads: string[]; loadedSet: Set<string> } {
  const loadedSet = new Set(loaded);
  const loads: string[] = [];
  const deps: ModuleDeps = {
    readDesired: async () => null,
    isLoaded: (name) => loadedSet.has(name),
    loadModule: (name) => { loads.push(name); loadedSet.add(name); },
  };
  return { deps, loads, loadedSet };
}

const specs = (...names: string[]): ModuleSpec[] => names.map((name) => ({ name }));

describe('moduleNameValid', () => {
  it('accepts real module names', () => {
    for (const n of ['overlay', 'br_netfilter', 'nf_conntrack', 'ip6_tables', 'dm-mod']) {
      expect(moduleNameValid(n)).toBe(true);
    }
  });
  it('rejects path / shell / empty / overlong names', () => {
    for (const n of ['', '../evil', 'a b', 'mod;rm', 'MOD', '-bad', '/proc/x', 'a'.repeat(65)]) {
      expect(moduleNameValid(n)).toBe(false);
    }
  });
});

describe('convergeModules', () => {
  it('absent → benign', () => {
    expect(convergeModules(null, true, fakeDeps().deps).desiredSource).toBe('absent');
  });
  it('loads missing modules (enforce)', () => {
    const { deps, loads } = fakeDeps([]);
    const r = convergeModules(specs('overlay', 'br_netfilter'), true, deps);
    expect(r.loadedCount).toBe(2);
    expect(loads).toEqual(['overlay', 'br_netfilter']);
    expect(r.items.every((i) => i.state === 'loaded-now')).toBe(true);
  });
  it('already-loaded → loaded, no load call', () => {
    const { deps, loads } = fakeDeps(['overlay']);
    const r = convergeModules(specs('overlay'), true, deps);
    expect(r.items[0].state).toBe('loaded');
    expect(loads).toHaveLength(0);
  });
  it('dry-run reports would-load, loads nothing', () => {
    const { deps, loads } = fakeDeps([]);
    const r = convergeModules(specs('overlay'), false, deps);
    expect(r.items[0].state).toBe('would-load');
    expect(loads).toHaveLength(0);
  });
  it('invalid name → not-allowed, never loaded', () => {
    const { deps, loads } = fakeDeps([]);
    const r = convergeModules(specs('../evil'), true, deps);
    expect(r.items[0].state).toBe('not-allowed');
    expect(loads).toHaveLength(0);
  });
  it('records a load failure (ok=false)', () => {
    const deps: ModuleDeps = {
      readDesired: async () => null,
      isLoaded: () => false,
      loadModule: () => { throw new Error('modprobe: FATAL'); },
    };
    const r = convergeModules(specs('nf_tables'), true, deps);
    expect(r.ok).toBe(false);
    expect(r.items[0].state).toBe('load-failed');
  });
  it('refuses an oversized policy wholesale (ok=false, no items, never throws)', () => {
    const big = specs(...Array.from({ length: 150 }, (_, i) => `mod_${i}`));
    const { deps, loads } = fakeDeps();
    const r = convergeModules(big, true, deps);
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
    expect(r.reason).toMatch(/150 modules/);
    expect(loads).toHaveLength(0); // refused before any modprobe
  });
});
