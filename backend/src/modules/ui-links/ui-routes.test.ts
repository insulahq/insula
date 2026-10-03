import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER,
  checkLink,
  extractEmittedLinks,
  extractFrontendLinks,
  parseIngressPrefixes,
  parseNginxPrefixes,
  parseRouteTable,
  parseTabbedPages,
  type PanelRoutes,
} from '../../test-helpers/ui-routes.js';

// The matcher behind the link guard. Every arm is exercised in both
// directions — a guard that can only pass is not a guard.

const APP = `
  <Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/" element={<Layout />}>
      <Route index element={<Dashboard />} />
      <Route path="tenants" element={<TenantsLayout />}>
        <Route index element={<Navigate to="/tenants/list" replace />} />
        <Route path="list" element={<List />} />
      </Route>
      <Route path="tenants/:id/:tab?" element={<TenantDetail />} />
      <Route path="monitoring/:tab?" element={<ProtectedRoute allowedRoles={['admin']}><Monitoring /></ProtectedRoute>} />
      <Route path="monitoring/audit-logs" element={<AuditLogs />} />
      <Route
        path="resource-usage"
        element={<Navigate to="/monitoring/traffic" replace />}
      />
      <Route path="old" element={<Navigate to="/nowhere" replace />} />
      <Route path="*" element={<NotFound />} />
    </Route>
  </Routes>`;

const TABS = `
export const TABBED_PAGES = {
  '/tenants/:id': ['domains', 'backups'],
  '/monitoring': [
    'traffic', 'slos',
  ],
} as const;
`;

const panel: PanelRoutes = {
  panel: 'admin', routes: parseRouteTable(APP), tabs: parseTabbedPages(TABS), serverPaths: ['/metrics/', '/api/v1/'],
};

describe('parseRouteTable', () => {
  it('tracks nesting, index routes, absolute paths and multi-line tags', () => {
    expect(panel.routes.map((r) => r.pattern)).toEqual([
      '/login', '/', '/', '/tenants', '/tenants', '/tenants/list', '/tenants/:id/:tab?',
      '/monitoring/:tab?', '/monitoring/audit-logs', '/resource-usage', '/old', '/*',
    ]);
    expect(panel.routes.find((r) => r.pattern === '/resource-usage')?.redirectTo).toBe('/monitoring/traffic');
  });
});

describe('parseTabbedPages', () => {
  it('reads single- and multi-line tab lists', () => {
    expect([...panel.tabs]).toEqual([['/tenants/:id', ['domains', 'backups']], ['/monitoring', ['traffic', 'slos']]]);
  });
});

describe('checkLink', () => {
  it('accepts real routes, params, the index route and external links', () => {
    for (const ok of ['/', '/tenants/list', '/tenants/abc', '/tenants/abc/backups', 'https://example.test/x', '//cdn.example.test']) {
      expect(checkLink(panel, ok), ok).toBeNull();
    }
  });

  it('rejects a path no route declares — the catch-all is "Page Not Found", not a match', () => {
    expect(checkLink(panel, '/settings/storage')).toMatch(/no admin-panel route matches/);
  });

  it('checks the tab, in the path and in the legacy query', () => {
    expect(checkLink(panel, '/monitoring/slos')).toBeNull();
    expect(checkLink(panel, '/monitoring?tab=slos')).toBeNull();
    // The bug that prompted this guard.
    expect(checkLink(panel, '/monitoring/slo')).toMatch(/\/monitoring has no tab "slo"/);
    expect(checkLink(panel, '/monitoring?tab=slo')).toMatch(/no tab "slo"/);
    expect(checkLink(panel, '/tenants/abc/nope')).toMatch(/\/tenants\/:id has no tab "nope"/);
  });

  it('prefers a static route over a tab of the same shape', () => {
    expect(checkLink(panel, '/monitoring/audit-logs')).toBeNull();
  });

  it('rejects ?tab= on a page without tabs — it would be silently ignored', () => {
    expect(checkLink(panel, '/tenants/list?tab=x')).toMatch(/a page with no tabs/);
  });

  it('follows a redirect and checks where it lands', () => {
    expect(checkLink(panel, '/resource-usage')).toBeNull();
    expect(checkLink(panel, '/tenants')).toBeNull();
    expect(checkLink(panel, '/old')).toMatch(/redirects to \/nowhere/);
  });

  it('cannot check a runtime tab, but still checks the page', () => {
    expect(checkLink(panel, `/monitoring/${PLACEHOLDER}`)).toBeNull();
    expect(checkLink(panel, `/nowhere/${PLACEHOLDER}`)).toMatch(/no admin-panel route/);
  });
});

describe('extractFrontendLinks', () => {
  it('finds JSX, navigate, location and object links, and normalises templates', () => {
    const src = [
      '<Link to="/a">', "<Link to={'/b'}>", '<Tile to={`/tenants/${t.id}/backups`}>', '<a href="/c">',
      "navigate('/d');", 'navigate(`/e?tab=${x ?? 1}`);', "window.location.href = '/f';",
      "{ to: '/g', href: '/h', actionPath: '/i' }",
      // not links
      "fetch('/api/v1/x')", "navigate(`${base}/x`)", "<a href=\"https://example.test\">",
    ].join('\n');
    expect(extractFrontendLinks(src).sort()).toEqual(
      ['/a', '/b', `/tenants/${PLACEHOLDER}/backups`, '/c', '/d', `/e?tab=${PLACEHOLDER}`, '/f', '/g', '/h', '/i'].sort(),
    );
  });
});

describe('server-side paths', () => {
  it('reads literal nginx locations, not the SPA catch-all or regex locations', () => {
    const conf = 'location /health {\n location ^~ /api/v1/ {\n location = /config.js {\n location / {\n location ~* \\.(js)$ {';
    expect(parseNginxPrefixes(conf)).toEqual(['/health', '/api/v1/', '/config.js']);
  });

  it('reads IngressRoute paths for the panel host only', () => {
    const yaml = [
      '    - match: "Host(`admin.${DOMAIN}`) && (Path(`/metrics`) || PathPrefix(`/metrics/`))"',
      '    - match: "Host(`mail.${DOMAIN}`) && PathPrefix(`/jmap`)"',
    ].join('\n');
    expect(parseIngressPrefixes(yaml, 'admin.${DOMAIN}')).toEqual(['/metrics', '/metrics/']);
  });

  it('a link to a server-side path is not the router\'s business', () => {
    expect(checkLink(panel, '/metrics/vmui/')).toBeNull();
    expect(checkLink(panel, '/metricsx')).toMatch(/no admin-panel route/);
  });
});

describe('extractEmittedLinks', () => {
  it('reads href/actionPath values, ternaries included, and skips API routes', () => {
    const src = [
      "href: n === 1 ? `/tenants/${t}/domains/${d}` : '/tenants/domains',",
      "actionPath: '/a', url: '/api/v1/c', path: '/spec/x',",
      "app.post('/admin/mail/rotate', handler);",
    ].join('\n');
    expect(extractEmittedLinks(src)).toEqual([
      { panel: null, href: `/tenants/${PLACEHOLDER}/domains/${PLACEHOLDER}` },
      { panel: null, href: '/tenants/domains' },
      { panel: null, href: '/a' },
    ]);
  });

  it('attributes panelRoute targets to their panel', () => {
    const src = "target: panelRoute(scope, { admin: `/tenants/${t}/domains/${d}`, tenant: `/domains/${d}` }),";
    expect(extractEmittedLinks(src)).toEqual([
      { panel: 'admin', href: `/tenants/${PLACEHOLDER}/domains/${PLACEHOLDER}` },
      { panel: 'tenant', href: `/domains/${PLACEHOLDER}` },
    ]);
  });

  it('ignores paths that only appear in comments', () => {
    expect(extractEmittedLinks("// href: '/old/path'\n/* actionPath: '/x' */ const a = 1;")).toEqual([]);
  });

  it('a // inside a string is not a comment — the rest of the line is still checked', () => {
    expect(extractEmittedLinks("const u = 'https://x//y'; href: '/kept',")).toEqual([{ panel: null, href: '/kept' }]);
    expect(extractEmittedLinks("note: 'see //docs', actionPath: '/also-kept' // trailing comment '/gone'")).toEqual([
      { panel: null, href: '/also-kept' },
    ]);
  });
});
