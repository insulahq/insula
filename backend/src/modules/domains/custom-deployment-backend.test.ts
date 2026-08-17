/**
 * The ingress reconciler must resolve the Service name the custom-deployment
 * deployer actually created.
 *
 * These drifted apart: the deployer appends the PORT name
 * (`wildapp` + `http` → `wildapp-http`) while the reconciler re-derived
 * `wildapp`. Traefik logged `kubernetes service not found: <ns>/wildapp` and
 * every hostname routed to a custom deployment answered 404 — with the route,
 * the certificate and the pods all healthy, so nothing looked wrong anywhere
 * else. Caught on a live cluster, not by any test.
 *
 * The two sides now share `serviceObjectName`; these tests pin the contract so
 * a future edit to either one has to break an assertion rather than a tenant.
 */

import { describe, it, expect } from 'vitest';
import { serviceObjectName, serviceResourceName } from '../custom-deployments/k8s-deployer.js';

describe('serviceObjectName', () => {
  it('appends the port name to a single-service deployment', () => {
    expect(serviceObjectName('wildapp', 'app', 1, 'http')).toBe('wildapp-http');
  });

  it('includes the stack service name when there are several', () => {
    expect(serviceObjectName('stack', 'api', 3, 'http')).toBe('stack-api-http');
  });

  it('is the workload name plus the port name, always', () => {
    // The workload name (Deployment + `app=` selector) deliberately has NO
    // port suffix — that difference is what made the two derivations look
    // interchangeable.
    for (const [dep, svc, count, port] of [
      ['a', 'only', 1, 'http'],
      ['a', 'web', 2, 'https'],
      ['long-deployment-name', 'svc', 4, 'grpc'],
    ] as const) {
      expect(serviceObjectName(dep, svc, count, port)).toBe(
        `${serviceResourceName(dep, svc, count)}-${port}`,
      );
    }
  });

  it('never returns the bare workload name', () => {
    // The exact shape of the bug: a Service named `wildapp` never exists.
    expect(serviceObjectName('wildapp', 'app', 1, 'http')).not.toBe(
      serviceResourceName('wildapp', 'app', 1),
    );
  });
});
