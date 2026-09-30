/**
 * The live IngressRoute index behind route naming: read from the cluster,
 * held briefly, and never allowed to hang or fail a traffic request.
 */
import { describe, it, expect, vi } from 'vitest';
import { createLiveRouteSource } from './live-ingress-routes.js';

const NS = 'tenant-example-0a1b2c3d';
const LABEL = `${NS}-${NS}-ingress-69f7b9a673940005ba26@kubernetescrd`;
const body = {
  items: [{
    metadata: { namespace: NS, name: `${NS}-ingress` },
    spec: {
      entryPoints: ['websecure'],
      routes: [{ match: 'Host(`www.example.test`)', kind: 'Rule', services: [{ name: 'website', port: 80 }] }],
    },
  }],
};

describe('createLiveRouteSource', () => {
  it('indexes the listed routes by Traefik service label', async () => {
    const source = createLiveRouteSource(() => Promise.resolve(body));
    const index = await source();
    expect(index.get(LABEL)?.backendService).toBe('website');
  });

  it('asks the cluster once per TTL, not once per request', async () => {
    let t = 0;
    const list = vi.fn(() => Promise.resolve(body));
    const source = createLiveRouteSource(list, { ttlMs: 30_000, now: () => t });
    await source();
    t = 29_999;
    await source();
    expect(list).toHaveBeenCalledTimes(1);
    t = 30_000;
    await source();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight read between concurrent requests', async () => {
    const list = vi.fn(() => Promise.resolve(body));
    const source = createLiveRouteSource(list);
    await Promise.all([source(), source(), source()]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('rejects on a failed read, and does not ask again until the TTL passes', async () => {
    let t = 0;
    const list = vi.fn(() => Promise.reject(new Error('forbidden')));
    const source = createLiveRouteSource(list, { ttlMs: 30_000, now: () => t });
    await expect(source()).rejects.toThrow('forbidden');
    t = 10_000;
    await expect(source()).rejects.toThrow('forbidden');
    expect(list).toHaveBeenCalledTimes(1);
    t = 30_000;
    await expect(source()).rejects.toThrow('forbidden');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('recovers once the cluster answers again', async () => {
    let t = 0;
    let fail = true;
    const list = vi.fn(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve(body)));
    const source = createLiveRouteSource(list, { ttlMs: 1_000, now: () => t });
    await expect(source()).rejects.toThrow('down');
    fail = false;
    t = 1_000;
    expect((await source()).size).toBe(1);
  });

  it('gives up on a read that hangs, rather than holding the traffic request', async () => {
    vi.useFakeTimers();
    try {
      const source = createLiveRouteSource(() => new Promise(() => { /* never settles */ }), { timeoutMs: 3_000 });
      const pending = source();
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('never stacks a second list on top of one that is still hanging', async () => {
    // A timed-out read is abandoned, not cancelled. Re-issuing it every TTL
    // against a slow API server would pile up open requests, so the next
    // window waits on the SAME request instead of starting another.
    vi.useFakeTimers();
    try {
      let t = 0;
      let settle: (v: unknown) => void = () => undefined;
      const list = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
      const source = createLiveRouteSource(list, { ttlMs: 1_000, timeoutMs: 100, now: () => t });
      const first = expect(source()).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(100);
      await first;
      t = 1_000;
      const second = source();
      settle(body);
      expect((await second).size).toBe(1);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a synchronous throw from the lister (no kubeconfig) into a rejection', async () => {
    const source = createLiveRouteSource(() => { throw new Error('no usable Kubernetes config'); });
    await expect(source()).rejects.toThrow('no usable Kubernetes config');
  });
});
