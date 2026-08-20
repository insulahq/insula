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

describe('probe target', () => {
  it('probes the HTTPS (websecure) entrypoint, not plaintext :80', async () => {
    // Every platform router binds entryPoints: ["websecure"]. Probing :80
    // matches NO router, so Traefik answers its unrouted 404 — the exact
    // signal this collector reads as "the panel is down". The first version
    // did that and reported both panels broken on a healthy cluster: a
    // permanent false critical alert on every install.
    //
    // Asserted on the URL the probe actually requests, because the unit tests
    // inject fetch and would otherwise pass against any target at all — which
    // is why the original bug survived them and only surfaced on a cluster.
    let requested = '';
    const f = (async (url: unknown) => {
      requested = String(url);
      return { status: 200, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;

    await probeHostRouted('admin.example.test', f);
    expect(requested).toMatch(/^https:\/\//);
    expect(requested).toContain(':443');
  });

  it('sends the panel hostname as the Host header', async () => {
    // Traefik's HTTP router matches on Host; without it the probe tests
    // nothing about the panel it claims to be checking.
    let sent: Record<string, string> | undefined;
    const f = (async (_u: unknown, init?: RequestInit) => {
      sent = init?.headers as Record<string, string>;
      return { status: 200, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;

    await probeHostRouted('tenant.example.test', f);
    expect(sent?.Host).toBe('tenant.example.test');
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
