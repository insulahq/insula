/**
 * CrowdSec + the WAF on the mail web surfaces. Webmail and the Stalwart host
 * (web admin + JMAP) were the platform's only UIs with neither, and both
 * IngressRoutes are Flux-disowned — running clusters only get the guards from
 * this converger. The routes that carry mail get the WAF only once the sidecar
 * runs the exclusion that lets mail through on their host.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  JMAP_UPLOAD_PRIORITY,
  exclusionHostPatterns,
  liveMailExclusions,
  reconcileMailEdgeGuards,
  withEdgeGuards,
  withMailEdgeGuards,
} from './traefik-mail-waf.js';
import { withInflightBeforeCompress, type MiddlewareRef } from './traefik-compress-bounds.js';
import { modsecDeployHash } from '../modules/waf-rule-exclusions/reconciler.js';
import { MERGE_PATCH } from './k8s-patch.js';

const mw = (name: string, namespace = 'traefik'): MiddlewareRef => ({ name, namespace });
const names = (l: ReadonlyArray<MiddlewareRef> | undefined): string[] => (l ?? []).map((m) => m.name ?? '');

/** The real exclusion file, as Flux renders it for apex example.test. */
const RENDERED = (() => {
  const yaml = readFileSync(fileURLToPath(new URL('../../../k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml', import.meta.url)), 'utf8');
  const conf = yaml.split('REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf: |\n')[1];
  return conf.split('\n').map((l) => l.replace(/^ {4}/, '')).join('\n').replaceAll('${DOMAIN}', 'example.test');
})();
const LIVE = exclusionHostPatterns(RENDERED);

const HOST = 'stalwart.example.test';
const stalwartRoutes = () => [
  {
    match: `Host(\`${HOST}\`) && (PathPrefix(\`/jmap\`) || Path(\`/.well-known/jmap\`))`,
    kind: 'Rule',
    middlewares: [mw('stalwart-jmap-cors', 'mail'), mw('inflight-per-client'), mw('compress')],
    services: [{ name: 'stalwart-mgmt', port: 8080 }],
  },
  {
    match: `Host(\`${HOST}\`)`,
    kind: 'Rule',
    middlewares: [mw('admin-auth-cookie'), mw('inflight-per-client'), mw('compress')],
    services: [{ name: 'stalwart-mgmt', port: 8080 }],
  },
];
const webmailRoute = (host = 'webmail.example.test', middlewares = [mw('inflight-per-client'), mw('compress')]) =>
  [{ match: `Host(\`${host}\`)`, middlewares, services: [{ name: 'bulwark', port: 80 }] }];

describe('withEdgeGuards', () => {
  it('runs CrowdSec first and the WAF after the auth gate, before the concurrency cap', () => {
    const r = withEdgeGuards([mw('admin-auth-cookie'), mw('inflight-per-client'), mw('compress')], { waf: true });
    expect(names(r.middlewares)).toEqual(['crowdsec', 'admin-auth-cookie', 'waf-body-limit', 'modsecurity-crs', 'inflight-per-client', 'compress']);
  });

  it('puts the WAF after the CORS headers, so a refusal still reaches the SPA as one', () => {
    const r = withEdgeGuards([mw('stalwart-jmap-cors', 'mail'), mw('inflight-per-client'), mw('compress')], { waf: true });
    expect(names(r.middlewares)).toEqual(['crowdsec', 'stalwart-jmap-cors', 'waf-body-limit', 'modsecurity-crs', 'inflight-per-client', 'compress']);
  });

  it('never attaches the WAF without the body cap in front of it', () => {
    for (const list of [[], [mw('compress')], [mw('modsecurity-crs'), mw('inflight-per-client')]]) {
      const n = names(withEdgeGuards(list, { waf: true }).middlewares);
      expect(n.indexOf('waf-body-limit')).toBe(n.indexOf('modsecurity-crs') - 1);
    }
  });

  it('without the WAF: CrowdSec only, cap and WAF removed together', () => {
    const r = withEdgeGuards([mw('stalwart-jmap-cors', 'mail'), mw('waf-body-limit'), mw('modsecurity-crs'), mw('inflight-per-client')], { waf: false });
    expect(names(r.middlewares)).toEqual(['crowdsec', 'stalwart-jmap-cors', 'inflight-per-client']);
  });

  it('is idempotent and leaves the compress invariant intact', () => {
    const once = withEdgeGuards([mw('admin-auth-cookie'), mw('inflight-per-client'), mw('compress')], { waf: true }).middlewares;
    expect(withEdgeGuards(once, { waf: true }).changed).toBe(false);
    expect(withInflightBeforeCompress(once).changed).toBe(false);
  });
});

describe('exclusionHostPatterns — read back from the real exclusion file', () => {
  it('finds the mail exclusions and the hosts they cover', () => {
    expect(LIVE.get('9000118')?.test('stalwart.example.test')).toBe(true);
    expect(LIVE.get('9000119')?.test('webmail.example.test')).toBe(true);
  });

  it('a renamed host is not covered', () => {
    expect(LIVE.get('9000119')?.test('mail-web.example.test')).toBe(false);
    expect(LIVE.get('9000118')?.test('stalwart.other.test')).toBe(false);
  });
});

describe('withMailEdgeGuards', () => {
  it('Stalwart: upload carve-out above the JMAP route, the WAF on JMAP and admin', () => {
    const r = withMailEdgeGuards('stalwart-webadmin', stalwartRoutes(), LIVE);
    expect(r.routes).toHaveLength(3);
    const [upload, jmap, admin] = r.routes;
    expect(upload.match).toBe(`Host(\`${HOST}\`) && PathPrefix(\`/jmap/upload\`)`);
    expect(upload.priority).toBe(JMAP_UPLOAD_PRIORITY);
    expect(names(upload.middlewares)).toEqual(['crowdsec', 'stalwart-jmap-cors', 'inflight-per-client', 'compress']);
    expect(upload.services).toEqual([{ name: 'stalwart-mgmt', port: 8080 }]);
    expect(names(jmap.middlewares)).toEqual(['crowdsec', 'stalwart-jmap-cors', 'waf-body-limit', 'modsecurity-crs', 'inflight-per-client', 'compress']);
    expect(names(admin.middlewares)).toEqual(['crowdsec', 'admin-auth-cookie', 'waf-body-limit', 'modsecurity-crs', 'inflight-per-client', 'compress']);
  });

  it('the carve-out outranks the JMAP route, whose default priority is its rule length', () => {
    const jmapRule = stalwartRoutes()[0].match;
    expect(JMAP_UPLOAD_PRIORITY).toBeGreaterThan(jmapRule.replace('example.test', 'a-very-long-platform-apex.example.test').length);
  });

  it('exclusions not yet live: CrowdSec everywhere, the WAF only where mail does not pass', () => {
    const [, jmap, admin] = withMailEdgeGuards('stalwart-webadmin', stalwartRoutes(), null).routes;
    expect(names(jmap.middlewares)).not.toContain('modsecurity-crs');
    expect(names(jmap.middlewares)[0]).toBe('crowdsec');
    expect(names(admin.middlewares)).toContain('modsecurity-crs');
    expect(names(withMailEdgeGuards('platform-webmail-ingress', webmailRoute(), null).routes[0].middlewares))
      .toEqual(['crowdsec', 'inflight-per-client', 'compress']);
  });

  it('unknown is not "off": a WAF already in place stays while the exclusions cannot be read', () => {
    const guarded = withMailEdgeGuards('platform-webmail-ingress', webmailRoute(), LIVE).routes;
    const again = withMailEdgeGuards('platform-webmail-ingress', guarded, null);
    expect(again.changed).toBe(false);
  });

  it('a renamed webmail host gets CrowdSec but not the WAF — its mail would be refused', () => {
    const fromManifest = webmailRoute('mail-web.example.test', [mw('crowdsec'), mw('waf-body-limit'), mw('modsecurity-crs'), mw('inflight-per-client'), mw('compress')]);
    const r = withMailEdgeGuards('platform-webmail-ingress', fromManifest, LIVE);
    expect(names(r.routes[0].middlewares)).toEqual(['crowdsec', 'inflight-per-client', 'compress']);
  });

  it('webmail stays ONE route — the webmail router rewrites it as routes[0] only', () => {
    const r = withMailEdgeGuards('platform-webmail-ingress', webmailRoute(), LIVE);
    expect(r.routes).toHaveLength(1);
    expect(names(r.routes[0].middlewares)).toEqual(['crowdsec', 'waf-body-limit', 'modsecurity-crs', 'inflight-per-client', 'compress']);
  });

  it('no carve-out possible (no parseable host): the JMAP route keeps no WAF — attachments would be refused', () => {
    const routes = stalwartRoutes();
    routes[0] = { ...routes[0], match: 'PathPrefix(`/jmap`)' };
    const r = withMailEdgeGuards('stalwart-webadmin', routes, LIVE);
    expect(r.routes).toHaveLength(2);
    expect(names(r.routes[0].middlewares)).not.toContain('modsecurity-crs');
  });

  it('converged routes are left alone', () => {
    const once = withMailEdgeGuards('stalwart-webadmin', stalwartRoutes(), LIVE).routes;
    expect(withMailEdgeGuards('stalwart-webadmin', once, LIVE).changed).toBe(false);
  });
});

function fakeCore(staticConf: string, renderedHash = 'dyn-hash') {
  return {
    readNamespacedConfigMap: vi.fn(async (req: { name: string }) => (req.name === 'modsec-crs-exclusions'
      ? { data: { 'REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf': staticConf } }
      : { metadata: { annotations: { 'insula.host/waf-exclusion-hash': renderedHash } } })),
  };
}
function fakeApps(stamp: string, status = { observedGeneration: 4, replicas: 2, updatedReplicas: 2, availableReplicas: 2 }) {
  return {
    readNamespacedDeployment: vi.fn(async () => ({
      metadata: { generation: 4 },
      spec: { replicas: 2, template: { metadata: { annotations: { 'insula.host/waf-exclusion-hash': stamp } } } },
      status,
    })),
  };
}

describe('liveMailExclusions — what the sidecar RUNS, not what the ConfigMap says', () => {
  it('the exclusions, once the pods were rolled onto them', async () => {
    const live = await liveMailExclusions(fakeCore(RENDERED) as never, fakeApps(modsecDeployHash('dyn-hash', RENDERED)) as never);
    expect(live?.get('9000119')?.test('webmail.example.test')).toBe(true);
  });

  it('unknown while the pods still carry the old stamp', async () => {
    expect(await liveMailExclusions(fakeCore(RENDERED) as never, fakeApps('old') as never)).toBeNull();
  });

  it('unknown mid-rollout — an old pod may answer the next request', async () => {
    const rolling = { observedGeneration: 4, replicas: 3, updatedReplicas: 2, availableReplicas: 2 };
    expect(await liveMailExclusions(fakeCore(RENDERED) as never, fakeApps(modsecDeployHash('dyn-hash', RENDERED), rolling) as never)).toBeNull();
  });

  it('unknown when a read fails', async () => {
    const core = { readNamespacedConfigMap: vi.fn(async () => { throw new Error('403'); }) };
    expect(await liveMailExclusions(core as never, fakeApps('x') as never)).toBeNull();
  });
});

describe('reconcileMailEdgeGuards', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  function fakeCustom(missingMiddleware?: string) {
    const objects: Record<string, unknown> = {
      'platform-webmail-ingress': { metadata: { resourceVersion: '7' }, spec: { routes: webmailRoute() } },
      'stalwart-webadmin': { metadata: { resourceVersion: '9' }, spec: { routes: stalwartRoutes() } },
    };
    return {
      getNamespacedCustomObject: vi.fn(async (req: { plural: string; name: string }) => {
        if (req.plural === 'middlewares') {
          if (req.name === missingMiddleware) throw new Error('404');
          return {};
        }
        return objects[req.name];
      }),
      patchNamespacedCustomObject: vi.fn(async () => ({})),
    };
  }
  const clients = (custom: ReturnType<typeof fakeCustom>) => ({
    custom, core: fakeCore(RENDERED), apps: fakeApps(modsecDeployHash('dyn-hash', RENDERED)),
  }) as never;

  it('patches both routes, carrying the resourceVersion it read', async () => {
    const custom = fakeCustom();
    const r = await reconcileMailEdgeGuards(clients(custom), log);
    expect(r.patched).toEqual(['mail/platform-webmail-ingress', 'mail/stalwart-webadmin']);
    const [first] = custom.patchNamespacedCustomObject.mock.calls[0] as unknown as [{ body: { metadata: { resourceVersion: string } } }, unknown];
    expect(first.body.metadata.resourceVersion).toBe('7');
    expect(custom.patchNamespacedCustomObject.mock.calls[0][1]).toBe(MERGE_PATCH);
  });

  it('touches nothing until every guard Middleware exists — Traefik drops a router naming a missing one', async () => {
    for (const missing of ['crowdsec', 'waf-body-limit', 'modsecurity-crs']) {
      const custom = fakeCustom(missing);
      const r = await reconcileMailEdgeGuards(clients(custom), log);
      expect(r.patched).toEqual([]);
      expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
    }
  });
});
