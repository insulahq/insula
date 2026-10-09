import { describe, it, expect } from 'vitest';
import { resolveCustomRoutePort, planRoutesForPortEdit } from './route-port.js';

interface Port { name: string; containerPort: number; exposeAsService?: boolean; ingressEligible?: boolean }
const spec = (ports: Port[]) => ({ services: { app: { ports } } });
const http = (containerPort: number, extra: Partial<Port> = {}): Port =>
  ({ name: 'http', containerPort, exposeAsService: true, ingressEligible: true, ...extra });

describe('resolveCustomRoutePort', () => {
  it('lands an unpinned route on the ingress-eligible exposed port', () => {
    const s = spec([{ name: 'metrics', containerPort: 9100, exposeAsService: true }, http(8080)]);
    expect(resolveCustomRoutePort(s, null)).toEqual({ svcName: 'app', portName: 'http', port: 8080 });
  });

  it('lands a pinned route on the port with that number', () => {
    const s = spec([http(8080), { name: 'admin', containerPort: 9000, exposeAsService: true }]);
    expect(resolveCustomRoutePort(s, 9000)).toEqual({ svcName: 'app', portName: 'admin', port: 9000 });
  });

  it('refuses a port with no Service — there is nothing for the ingress to point at', () => {
    expect(resolveCustomRoutePort(spec([http(8080, { exposeAsService: false })]), 8080)).toBeUndefined();
    expect(resolveCustomRoutePort(spec([http(8080, { exposeAsService: false })]), null)).toBeUndefined();
  });

  it('finds nothing in a spec without services', () => {
    expect(resolveCustomRoutePort({}, null)).toBeUndefined();
  });
});

describe('planRoutesForPortEdit', () => {
  const route = (servicePort: number | null, hostname = 'shop.example.test') => ({ id: `r-${hostname}`, hostname, servicePort });

  it('needs nothing for an unpinned route that still resolves after a renumber', () => {
    const plan = planRoutesForPortEdit(spec([http(80)]), spec([http(8080)]), [route(null)]);
    expect(plan).toEqual({ repins: [], stranded: [] });
  });

  it('follows a pinned port to its new number when the name stays', () => {
    const plan = planRoutesForPortEdit(spec([http(80)]), spec([http(8080)]), [route(80)]);
    expect(plan).toEqual({ repins: [{ routeId: 'r-shop.example.test', servicePort: 8080 }], stranded: [] });
  });

  it('follows the port by name when two ports swap numbers, not the number to the other port', () => {
    const before = spec([http(80), { name: 'admin', containerPort: 9000, exposeAsService: true }]);
    const after = spec([http(8080), { name: 'admin', containerPort: 80, exposeAsService: true }]);
    const plan = planRoutesForPortEdit(before, after, [route(80)]);
    expect(plan).toEqual({ repins: [{ routeId: 'r-shop.example.test', servicePort: 8080 }], stranded: [] });
  });

  it('keeps a pinned route on its number when the port is only renamed', () => {
    const plan = planRoutesForPortEdit(spec([http(80)]), spec([http(80, { name: 'web' })]), [route(80)]);
    expect(plan).toEqual({ repins: [], stranded: [] });
  });

  it('strands a pinned route whose port was removed', () => {
    const before = spec([http(80), { name: 'admin', containerPort: 9000, exposeAsService: true }]);
    const plan = planRoutesForPortEdit(before, spec([http(80)]), [route(9000, 'admin.example.test')]);
    expect(plan).toEqual({ repins: [], stranded: ['admin.example.test'] });
  });

  it('strands an unpinned route when no port is ingress-eligible any more', () => {
    const plan = planRoutesForPortEdit(spec([http(80)]), spec([http(80, { ingressEligible: false })]), [route(null)]);
    expect(plan.stranded).toEqual(['shop.example.test']);
  });

  it('strands a pinned route whose port stopped being exposed', () => {
    const plan = planRoutesForPortEdit(spec([http(80)]), spec([http(80, { exposeAsService: false })]), [route(80)]);
    expect(plan.stranded).toEqual(['shop.example.test']);
  });

  it('does not blame the edit for a route that was already broken', () => {
    const plan = planRoutesForPortEdit(spec([http(80)]), spec([http(8080)]), [route(1234)]);
    expect(plan).toEqual({ repins: [], stranded: [] });
  });
});
