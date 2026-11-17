/**
 * The latency SLO's exclusion list: exactly the routes whose request lasts as
 * long as a transfer — built here from the SAME builders the clusters' routes
 * come from, so a carve-out whose rule changes cannot silently drop out of
 * (or a panel route slip into) the list.
 */

import { describe, it, expect } from 'vitest';
import { transferServiceLabels } from './transfer-routes.js';
import { buildDesiredRoutes, buildIngressRouteBody } from '../system-settings/ingress-reconciler.js';
import { jmapStreamMatch } from '../../shared/traefik-mail-waf.js';
import { buildTunnelIngressRoute } from '../private-workers/reconciler.js';
import { indexLiveRoutes, liveRoutesFromList } from '../traffic/traefik-routes.js';

const panels = buildIngressRouteBody(
  buildDesiredRoutes({
    adminPanelUrl: 'https://admin.example.test',
    tenantPanelUrl: 'https://panel.example.test',
    tlsSecretName: 'platform-tls',
    protectAdminViaProxy: true,
  }),
  { namespace: 'platform', name: 'platform-ingress', tlsSecretName: 'platform-tls' },
);

const stalwartHost = 'stalwart.example.test';
const stalwart = {
  metadata: { namespace: 'mail', name: 'stalwart-webadmin' },
  spec: {
    entryPoints: ['websecure'],
    routes: [
      { match: jmapStreamMatch(stalwartHost), services: [{ name: 'stalwart-mgmt', port: 8080 }] },
      {
        match: `Host(\`${stalwartHost}\`) && (PathPrefix(\`/jmap\`) || Path(\`/.well-known/jmap\`))`,
        services: [{ name: 'stalwart-mgmt', port: 8080 }],
      },
      { match: `Host(\`${stalwartHost}\`)`, services: [{ name: 'stalwart-mgmt', port: 8080 }] },
    ],
  },
};

const webmail = {
  metadata: { namespace: 'mail', name: 'platform-webmail-ingress' },
  spec: { routes: [{ match: 'Host(`webmail.example.test`)', services: [{ name: 'bulwark', port: 80 }] }] },
};

const tunnel = buildTunnelIngressRoute('photos-1a2b3c4d', 'photos-1a2b3c4d.tunnels.example.test', 'tenant-example');
const anchor = {
  metadata: { namespace: 'platform-system', name: 'tunnel-anchor' },
  spec: { routes: [{ match: 'Host(`tunnels.example.test`)', services: [{ name: 'tunnel-anchor-default', port: 80 }] }] },
};

const index = indexLiveRoutes(liveRoutesFromList({ items: [panels, stalwart, webmail, tunnel, anchor] }));
const matchesOf = (labels: readonly string[]) => labels.map((l) => index.get(l)!.match);

describe('transferServiceLabels', () => {
  const labels = transferServiceLabels(index);

  it('names the JMAP stream carve-out, both panels\' upload and download carve-outs and the tunnel', () => {
    const matches = matchesOf(labels);
    expect(matches.filter((m) => m.includes('/jmap/eventsource'))).toHaveLength(1);
    expect(matches.filter((m) => m.includes('files/upload-raw'))).toHaveLength(2);
    expect(matches.filter((m) => m.includes('files/download'))).toHaveLength(2);
    expect(matches.filter((m) => m.includes('/~!frp'))).toHaveLength(1);
    expect(labels).toHaveLength(6);
  });

  it('leaves every other route in: panels, sign-in, WAF admin, the JMAP API, the Stalwart admin, webmail, the tunnel anchor', () => {
    const left = [...index.keys()].filter((l) => !labels.includes(l));
    const matches = left.map((l) => index.get(l)!.match);
    expect(matches).toEqual(expect.arrayContaining([
      'Host(`admin.example.test`)',
      'Host(`panel.example.test`)',
      'Host(`admin.example.test`) && PathPrefix(`/oauth2`)',
      `Host(\`${stalwartHost}\`) && (PathPrefix(\`/jmap\`) || Path(\`/.well-known/jmap\`))`,
      `Host(\`${stalwartHost}\`)`,
      'Host(`webmail.example.test`)',
      'Host(`tunnels.example.test`)',
    ]));
    expect(matches.some((m) => m.includes('waf-rule-exclusions'))).toBe(true);
  });

  it('returns labels in Traefik\'s shape, the one the rule\'s series carry', () => {
    // The rule selects `(platform|mail)-.*`: the tunnel's `platform-system-…` falls inside it.
    for (const l of labels) expect(l).toMatch(/^(platform|mail)-[a-z0-9-]+-[0-9a-f]{20}@kubernetescrd$/);
  });

  it('drops a label that is not Traefik\'s shape rather than put it in a regex', () => {
    const odd = new Map([[
      'mail-x".*@kubernetescrd',
      { namespace: 'mail', objectName: 'x', entryPoints: [], match: jmapStreamMatch(stalwartHost), backendService: null },
    ]]);
    expect(transferServiceLabels(odd)).toEqual([]);
  });

  it('is empty when nothing is live', () => {
    expect(transferServiceLabels(new Map())).toEqual([]);
  });
});
