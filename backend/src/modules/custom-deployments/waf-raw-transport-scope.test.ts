/**
 * Every route the tenant panel calls with raw transport (the compose / spec
 * JSON labelled application/octet-stream, ADR-060) must be inside the URI
 * scope of WAF rule 9000115 — the only rule that lets an octet-stream body
 * past CRS 920420. Outside it the edge answers 403 and the API never sees the
 * request.
 *
 * The in-place stack edit first shipped as PUT /<id>/compose: unit tests,
 * integration tests and the API run against DEV's API all passed, and the
 * browser got "Blocked by the Web Application Firewall". This reads the
 * panel's own calls and the rule's own pattern, so a new raw route outside the
 * scope fails here instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string) => readFileSync(path.join(repo, rel), 'utf8');

/** The REQUEST_URI pattern chained to id:9000115. */
function rule9000115Uri(): RegExp {
  const conf = read('k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml');
  const at = conf.indexOf('id:9000115');
  expect(at).toBeGreaterThan(-1);
  const m = /SecRule REQUEST_URI "@rx ([^"]+)"/.exec(conf.slice(at));
  expect(m).not.toBeNull();
  return new RegExp(m![1]!);
}

/** The panel's raw-transport calls, as concrete URIs: `METHOD /api/v1/tenants/t1/custom-deployments/...`. */
function panelRawCalls(): string[] {
  const src = read('frontend/tenant-panel/src/hooks/use-custom-deployments.ts');
  const calls: string[] = [];
  const re = /apiFetch<[^>]*>\(\s*([^,]+),\s*\{([^}]*)\}/gs;
  for (const m of src.matchAll(re)) {
    const [, urlExpr, opts] = m;
    if (!opts!.includes('RAW_JSON_HEADERS')) continue;
    const method = /method:\s*'([A-Z]+)'/.exec(opts!)?.[1] ?? 'GET';
    const uri = urlExpr!.trim()
      .replace(/^`|`$/g, '')
      .replace(/\$\{BASE\(tenantId!\)\}|^BASE\(tenantId!\)$/g, '/api/v1/tenants/t1/custom-deployments')
      .replace(/\$\{query\}/g, '')
      .replace(/\$\{[^}]+\}/g, 'x1');
    calls.push(`${method} ${uri}`);
  }
  return calls;
}

describe('raw transport stays inside WAF rule 9000115', () => {
  it('finds the panel\'s raw-transport calls (create, validate, patch, in-place edit)', () => {
    expect(panelRawCalls().sort()).toEqual([
      'PATCH /api/v1/tenants/t1/custom-deployments/x1',
      'POST /api/v1/tenants/t1/custom-deployments',
      'POST /api/v1/tenants/t1/custom-deployments/validate',
      'PUT /api/v1/tenants/t1/custom-deployments/x1',
    ]);
  });

  it('★ every one of them matches the rule\'s URI pattern', () => {
    const scope = rule9000115Uri();
    for (const call of panelRawCalls()) {
      const uri = call.split(' ')[1]!;
      expect(scope.test(uri), `${call} is outside 9000115 — the WAF would refuse it`).toBe(true);
    }
  });

  it('and the pattern still keeps two-segment routes out (its own contract)', () => {
    const scope = rule9000115Uri();
    expect(scope.test('/api/v1/tenants/t1/custom-deployments/x1/compose')).toBe(false);
    expect(scope.test('/api/v1/tenants/t1/custom-deployments/x1/pull-credentials')).toBe(false);
  });
});
