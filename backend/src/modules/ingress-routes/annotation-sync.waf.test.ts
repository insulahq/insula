import { describe, it, expect } from 'vitest';
import { buildMiddlewaresForRoute, type RouteSettingsLike } from './annotation-sync.js';

const baseRoute: RouteSettingsLike = {
  forceHttps: 0,
  wwwRedirect: 'none',
  redirectUrl: null,
  ipAllowlist: null,
  rateLimitRps: null,
  rateLimitConnections: null,
  rateLimitBurstMultiplier: null,
  wafEnabled: 0,
  wafOwaspCrs: 0,
  wafAnomalyThreshold: 10,
  wafExcludedRules: null,
  customErrorCodes: null,
  customErrorPath: null,
};

describe('buildMiddlewaresForRoute — WAF (Coraza, option-C hybrid)', () => {
  it('emits NO Middleware and NO ref when WAF is disabled', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, wafEnabled: 0 },
      'route-12345678',
      'client-ns',
    );
    expect(middlewares.find((m) => m.metadata.name.endsWith('-waf'))).toBeUndefined();
    expect(referenceList.find((r) => r.name.endsWith('-waf') || r.name === 'coraza-base')).toBeUndefined();
  });

  it('attaches the shared coraza-base@traefik Middleware when WAF is on with default settings', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, wafEnabled: 1, wafOwaspCrs: 1 },
      'route-12345678',
      'client-ns',
    );
    // No per-route WAF Middleware emitted.
    expect(middlewares.find((m) => m.metadata.name.endsWith('-waf'))).toBeUndefined();
    // Reference to the shared base Middleware in the traefik namespace.
    const wafRef = referenceList.find((r) => r.name === 'coraza-base');
    expect(wafRef).toEqual({ name: 'coraza-base', namespace: 'traefik' });
  });

  it('emits a per-route Coraza Middleware when wafExcludedRules is set', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, wafEnabled: 1, wafOwaspCrs: 1, wafExcludedRules: '911100,920420' },
      'route-12345678',
      'client-ns',
    );
    const wafMw = middlewares.find((m) => m.metadata.name === 'r-route-12-waf');
    expect(wafMw).toBeDefined();
    const directives = (wafMw!.spec.plugin as { coraza: { directives: string } }).coraza.directives;
    expect(directives).toContain('SecRuleRemoveById 911100');
    expect(directives).toContain('SecRuleRemoveById 920420');
    // Reference points at the per-route Middleware, NOT coraza-base.
    expect(referenceList.find((r) => r.name === 'coraza-base')).toBeUndefined();
    expect(referenceList.find((r) => r.name === 'r-route-12-waf')).toEqual({
      name: 'r-route-12-waf',
      namespace: 'client-ns',
    });
  });

  it('emits a per-route Coraza Middleware when wafAnomalyThreshold differs from default (10)', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, wafEnabled: 1, wafOwaspCrs: 1, wafAnomalyThreshold: 5 },
      'route-12345678',
      'client-ns',
    );
    const wafMw = middlewares.find((m) => m.metadata.name === 'r-route-12-waf');
    expect(wafMw).toBeDefined();
    const directives = (wafMw!.spec.plugin as { coraza: { directives: string } }).coraza.directives;
    expect(directives).toContain('inbound_anomaly_score_threshold=5');
    expect(referenceList.find((r) => r.name === 'coraza-base')).toBeUndefined();
  });

  it('emits a per-route Coraza Middleware when wafOwaspCrs is off (opt-out of CRS)', () => {
    const { middlewares, referenceList } = buildMiddlewaresForRoute(
      { ...baseRoute, wafEnabled: 1, wafOwaspCrs: 0 },
      'route-12345678',
      'client-ns',
    );
    const wafMw = middlewares.find((m) => m.metadata.name === 'r-route-12-waf');
    expect(wafMw).toBeDefined();
    const directives = (wafMw!.spec.plugin as { coraza: { directives: string } }).coraza.directives;
    // Without OWASP CRS, the directive block must not include the
    // @owasp_crs bundle.
    expect(directives).not.toContain('@owasp_crs');
    expect(directives).toContain('SecRuleEngine On');
    expect(referenceList.find((r) => r.name === 'coraza-base')).toBeUndefined();
  });

  it('rejects garbage / non-numeric rule IDs from wafExcludedRules (defence against directive injection)', () => {
    // Note: any comma-segment with non-digit characters is dropped
    // whole — `920420; SecRuleEngine Off` doesn't get split further on
    // semicolons, so the whole segment is rejected. That's the safer
    // posture: tenants must comma-separate clean rule IDs.
    const { middlewares } = buildMiddlewaresForRoute(
      {
        ...baseRoute,
        wafEnabled: 1,
        wafOwaspCrs: 1,
        wafExcludedRules: '911100,not-a-rule-id,920420; SecRuleEngine Off',
      },
      'route-12345678',
      'client-ns',
    );
    const wafMw = middlewares.find((m) => m.metadata.name === 'r-route-12-waf');
    const directives = (wafMw!.spec.plugin as { coraza: { directives: string } }).coraza.directives;
    // The lone numeric segment is kept.
    expect(directives).toContain('SecRuleRemoveById 911100');
    // Garbage segments — including the one with attempted directive
    // injection — are silently dropped. No rogue SecRuleEngine Off
    // appears in the rendered directive block.
    expect(directives).not.toContain('not-a-rule-id');
    expect(directives).not.toContain('SecRuleEngine Off');
    // The trailing segment is rejected whole because it doesn't match
    // /^\d{3,7}$/.
    expect(directives).not.toContain('SecRuleRemoveById 920420');
  });
});
