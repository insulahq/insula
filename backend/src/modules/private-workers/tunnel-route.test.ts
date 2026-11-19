/**
 * A worker's tunnel route carries frpc's WebSocket handshake and nothing else.
 *
 * Matched on the host alone, every request to `<slug>.tunnels.<apex>` reached
 * frps's bind port, which answers only frp: anything else (a scanner's sweep
 * of the public name) got a 502 from Traefik and counted against the ingress
 * availability SLO.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { FRP_WEBSOCKET_PATH, buildTunnelIngressRoute, tunnelRouteMatch } from './reconciler.js';
import { parseMatchRule } from '../traffic/traefik-routes.js';

const HOST = 'photos-1a2b3c4d.tunnels.example.test';

describe('tunnelRouteMatch', () => {
  it('narrows the worker host to the one request frpc sends', () => {
    expect(tunnelRouteMatch(HOST)).toBe(`Host(\`${HOST}\`) && Path(\`/~!frp\`) && Method(\`GET\`)`);
  });

  it('normalises the host the way every other route does', () => {
    expect(tunnelRouteMatch('Photos-1A2B3C4D.Tunnels.Example.Test.')).toBe(tunnelRouteMatch(HOST));
  });

  it('still reads back as the worker host on the traffic pages', () => {
    const parsed = parseMatchRule(tunnelRouteMatch(HOST));
    expect(parsed?.hosts).toEqual([HOST]);
    expect(parsed?.path).toBe('/~!frp');
  });
});

describe('buildTunnelIngressRoute', () => {
  const body = buildTunnelIngressRoute('photos-1a2b3c4d', HOST, 'tenant-example');

  it('applies the narrowed rule — the route the cluster gets, not just the helper', () => {
    expect(body.spec.routes).toHaveLength(1);
    expect(body.spec.routes[0].match).toBe(tunnelRouteMatch(HOST));
  });

  it('keeps forwarding to frps\'s bind port behind the per-worker rate limit and certificate', () => {
    const [route] = body.spec.routes;
    expect(route.services).toEqual([{ name: 'tunnel-photos-1a2b3c4d', port: 7000 }]);
    expect(route.middlewares).toEqual([{ name: 'tunnel-photos-1a2b3c4d-ratelimit', namespace: 'platform-system' }]);
    expect(body.spec.tls).toEqual({ secretName: 'tunnel-photos-1a2b3c4d-tls' });
    expect(body.metadata.labels?.['insula.host/tenant-namespace']).toBe('tenant-example');
  });
});

describe('frp\'s WebSocket path', () => {
  // frp pkg/util/net/websocket.go: FrpWebsocketPath = "/~!frp" — a constant,
  // not configurable. The route now admits nothing else, so if a newer frp
  // moved it every tunnel would get Traefik's 404 instead of its server.
  const repo = (p: string) => readFileSync(fileURLToPath(new URL(`../../../../${p}`, import.meta.url)), 'utf8');

  it('is the path of the frp version both ends run', () => {
    expect(FRP_WEBSOCKET_PATH).toBe('/~!frp');
    // Checked against v0.72.0. Bumping frp? Re-read FrpWebsocketPath in the
    // new tag, then move these two pins and this test together.
    expect(repo('images/private-worker-agent/Dockerfile')).toMatch(/^ARG FRP_VERSION=0\.72\.0$/m);
    expect(repo('k8s/base/platform-config.yaml')).toContain('private-worker-frps-image: "fatedier/frps:v0.72.0"');
  });
});
