import { describe, it, expect } from 'vitest';
import {
  desiredResolverConcurrency,
  runDnsResolverReconcilerTick,
  type DnsResolverReconcilerDeps,
} from './dns-resolver-reconciler.js';

type Call = [string, Record<string, unknown>, string];

/** A fake Stalwart: x:DnsResolver singleton + x:Action reloads, recording every call. */
function fakeStalwart(resolver: Record<string, unknown> | null, opts: { reloadFails?: boolean } = {}) {
  const calls: Call[] = [];
  const state = resolver ? { ...resolver } : null;
  const deps: DnsResolverReconcilerDeps = {
    authHeader: 'Basic x',
    jmapPost: async (_auth, body) => {
      const { methodCalls } = body as { methodCalls: Call[] };
      calls.push(...methodCalls);
      return {
        methodResponses: methodCalls.map(([name, args, id]): Call => {
          if (name === 'x:DnsResolver/get') return [name, { list: state ? [state] : [] }, id];
          if (name === 'x:DnsResolver/set') {
            Object.assign(state ?? {}, (args.update as Record<string, Record<string, unknown>>).singleton);
            return [name, { updated: { singleton: null } }, id];
          }
          if (name === 'x:Action/set') {
            return [name, opts.reloadFails ? { notCreated: { r: { type: 'forbidden' } } } : { created: { r: { id: 'a1' } } }, id];
          }
          return ['error', { type: 'unknownMethod' }, id];
        }),
      };
    },
  };
  return { deps, calls, state };
}

describe('runDnsResolverReconcilerTick', () => {
  it('sets concurrency to 1 and reloads the settings when Stalwart runs 2', async () => {
    const s = fakeStalwart({ '@type': 'System', concurrency: 2, timeout: 5000 });
    const r = await runDnsResolverReconcilerTick(s.deps, 1);
    expect(r).toEqual({ outcome: 'updated', prior: 2, current: 1, reloaded: true });
    expect(s.calls.map((c) => c[0])).toEqual(['x:DnsResolver/get', 'x:DnsResolver/set', 'x:Action/set']);
    // Only the one property — the resolver type and its other settings are the operator's.
    expect(s.calls[1][1].update).toEqual({ singleton: { concurrency: 1 } });
    expect((s.calls[2][1].create as Record<string, unknown>).r).toEqual({ '@type': 'ReloadSettings' });
  });

  it('writes nothing when the value is already right', async () => {
    const s = fakeStalwart({ '@type': 'Custom', concurrency: 1 });
    expect(await runDnsResolverReconcilerTick(s.deps, 1)).toEqual({ outcome: 'unchanged', prior: 1, current: 1, reloaded: false });
    expect(s.calls.map((c) => c[0])).toEqual(['x:DnsResolver/get']);
  });

  it('says so when the reload did not run (the value then applies at the next restart)', async () => {
    const s = fakeStalwart({ '@type': 'System', concurrency: 2 }, { reloadFails: true });
    expect(await runDnsResolverReconcilerTick(s.deps, 1)).toMatchObject({ outcome: 'updated', reloaded: false });
  });

  it('refuses to guess when Stalwart returns no resolver singleton', async () => {
    const s = fakeStalwart(null);
    await expect(runDnsResolverReconcilerTick(s.deps, 1)).rejects.toThrow(/DnsResolver/);
    expect(s.calls.map((c) => c[0])).toEqual(['x:DnsResolver/get']);
  });
});

describe('desiredResolverConcurrency', () => {
  it('is 1 unless the operator sets a valid override', () => {
    expect(desiredResolverConcurrency({})).toBe(1);
    expect(desiredResolverConcurrency({ STALWART_DNS_RESOLVER_CONCURRENCY: '2' })).toBe(2);
    for (const bad of ['0', '-1', 'two', '1.5', '17', '']) {
      expect(desiredResolverConcurrency({ STALWART_DNS_RESOLVER_CONCURRENCY: bad })).toBe(1);
    }
  });
});
