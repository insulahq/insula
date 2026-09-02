import { describe, it, expect } from 'vitest';
import { buildRedirectSinkService, REDIRECT_SINK_SERVICE_NAME, REDIRECT_SINK_PORT } from './redirect-sink.js';
import { buildIngressRoute } from '../ingress-routes/traefik-types.js';

describe('redirect sink Service', () => {
  it('is an ExternalName alias, so it costs no pod and no tenant quota', () => {
    const svc = buildRedirectSinkService('tenant-acme');
    expect(svc.spec.type).toBe('ExternalName');
    expect(svc.spec.externalName).toBe('tenant-errors.platform-system.svc.cluster.local');
    expect(svc.spec.ports[0].port).toBe(REDIRECT_SINK_PORT);
  });

  it('lives in the tenant namespace', () => {
    // The whole point: buildIngressRoute refuses a cross-namespace
    // services[].namespace ref, so the sink has to be local and reach the
    // platform backend by DNS instead.
    expect(buildRedirectSinkService('tenant-acme').metadata.namespace).toBe('tenant-acme');
  });

  it('can actually be referenced by a tenant IngressRoute', () => {
    // Guards the real constraint: pointing straight at a Service in the
    // platform namespace throws here, which is why the sink exists at all.
    expect(() => buildIngressRoute({
      name: 'tenant-acme-ingress',
      namespace: 'tenant-acme',
      routes: [{
        match: 'Host(`example.test`)',
        services: [{ name: REDIRECT_SINK_SERVICE_NAME, port: REDIRECT_SINK_PORT }],
      }],
    } as never)).not.toThrow();

    expect(() => buildIngressRoute({
      name: 'tenant-acme-ingress',
      namespace: 'tenant-acme',
      routes: [{
        match: 'Host(`example.test`)',
        services: [{ name: 'tenant-errors', port: 80, namespace: 'platform-system' }],
      }],
    } as never)).toThrow(/cross-namespace/i);
  });
});
