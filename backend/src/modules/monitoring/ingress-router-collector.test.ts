import { describe, it, expect, beforeEach } from 'vitest';
import { probeHostRouted, collectIngressRoutersOnce } from './ingress-router-collector.js';
import { ingressRouterUp } from '../../shared/metrics.js';

const log = { warn: () => {} };

/** Minimal Response stand-in — avoids depending on undici internals. */
function res(status: number, body = ''): Response {
  return { status, text: async () => body } as unknown as Response;
}

describe('probeHostRouted', () => {
  it('reports 0 when Traefik serves its OWN unrouted 404', async () => {
    // This exact body is Go's http.NotFound — what Traefik returns when no
    // router matches, which is the 2026-08-20 outage signature.
    const f = (async () => res(404, '404 page not found\n')) as unknown as typeof fetch;
    const r = await probeHostRouted('admin.example.test', f);
    expect(r.value).toBe(0);
    expect(r.detail).toContain('NO ROUTER');
  });

  it('reports 1 for an APPLICATION 404 (routed, unknown path)', async () => {
    // A routed request that 404s is not an ingress failure. Keying on status
    // alone would make this a false alarm.
    const f = (async () => res(404, '{"error":"Not Found","statusCode":404}')) as unknown as typeof fetch;
    const r = await probeHostRouted('admin.example.test', f);
    expect(r.value).toBe(1);
  });

  it('reports 1 for 200/302/401/500 — a router matched', async () => {
    for (const status of [200, 302, 401, 403, 500, 502]) {
      const f = (async () => res(status)) as unknown as typeof fetch;
      const r = await probeHostRouted('admin.example.test', f);
      expect(r.value).toBe(1);
    }
  });

  it('reports -1 (NOT 0) when the probe itself fails', async () => {
    // A collector outage must never look like a down panel, or it pages.
    const f = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await probeHostRouted('admin.example.test', f);
    expect(r.value).toBe(-1);
    expect(r.detail).toContain('probe failed');
  });
});

describe('collectIngressRoutersOnce', () => {
  beforeEach(() => ingressRouterUp.reset());

  it('sets one gauge sample per host, labelled by host', async () => {
    const f = (async (_u: unknown, init?: RequestInit) => {
      const host = (init?.headers as Record<string, string>)?.Host;
      return host === 'admin.example.test' ? res(404, '404 page not found') : res(200);
    }) as unknown as typeof fetch;

    const out = await collectIngressRoutersOnce(['admin.example.test', 'tenant.example.test'], log, f);
    expect(out.map((r) => r.value)).toEqual([0, 1]);

    const data = await ingressRouterUp.get();
    const byHost = Object.fromEntries(data.values.map((v) => [v.labels.host, v.value]));
    expect(byHost['admin.example.test']).toBe(0);
    expect(byHost['tenant.example.test']).toBe(1);
  });

  it('never throws, even if a probe rejects', async () => {
    const f = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    await expect(collectIngressRoutersOnce(['admin.example.test'], log, f)).resolves.toBeDefined();
  });
});
