/**
 * The SQL Manager's statements travel as raw transport (the JSON labelled
 * application/octet-stream, ADR-060), and only WAF rule 9000121 lets that past
 * CRS 920420 — on exactly the two query routes. As application/json an
 * ordinary `SELECT … WHERE …` was refused at the edge as SQL injection.
 *
 * Unit and API tests that send JSON never meet the WAF, so this reads the
 * panel's own calls, the rule's own pattern and the routes' own source: a call
 * outside the scope, a scope that grows over the other DB-manager routes, or a
 * route that stops parsing octet-stream fails here instead of in a browser.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string) => readFileSync(path.join(repo, rel), 'utf8');

/** The REQUEST_URI pattern chained to id:9000121. */
function rule9000121Uri(): RegExp {
  const conf = read('k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml');
  const at = conf.indexOf('id:9000121');
  expect(at).toBeGreaterThan(-1);
  const m = /SecRule REQUEST_URI "@rx ([^"]+)"/.exec(conf.slice(at));
  expect(m).not.toBeNull();
  return new RegExp(m![1]!);
}

/** `METHOD uri` for each panel call sent with RAW_JSON_HEADERS, ids replaced by `x1`. */
function panelRawCalls(): string[] {
  const src = read('frontend/tenant-panel/src/hooks/use-sql-manager.ts');
  const calls: string[] = [];
  for (const m of src.matchAll(/apiFetch<[^>]*>\(\s*`([^`]+)`,\s*\{([^}]*)\}/gs)) {
    const [, url, opts] = m;
    if (!opts!.includes('RAW_JSON_HEADERS')) continue;
    const method = /method:\s*'([A-Z]+)'/.exec(opts!)?.[1] ?? 'GET';
    calls.push(`${method} ${url!.replace(/\$\{[^}]+\}/g, 'x1')}`);
  }
  return calls;
}

describe('SQL Manager raw transport stays inside WAF rule 9000121', () => {
  it('sends both statement-carrying calls as raw transport', () => {
    expect(panelRawCalls().sort()).toEqual([
      'POST /api/v1/tenants/x1/deployments/x1/query',
      'POST /api/v1/tenants/x1/sqlite/query',
    ]);
  });

  it('★ each of them matches the rule\'s URI pattern', () => {
    const scope = rule9000121Uri();
    for (const call of panelRawCalls()) {
      const uri = call.split(' ')[1]!;
      expect(scope.test(uri), `${call} is outside 9000121 — the WAF would refuse it`).toBe(true);
    }
  });

  it('keeps every other DB-manager route under the full rule set', () => {
    const scope = rule9000121Uri();
    for (const uri of [
      '/api/v1/tenants/t1/deployments',
      '/api/v1/tenants/t1/deployments/d1',
      '/api/v1/tenants/t1/deployments/d1/tables?database=x',
      '/api/v1/tenants/t1/deployments/d1/table-data?database=x&table=y',
      '/api/v1/tenants/t1/deployments/d1/row-count?database=x&table=y',
      '/api/v1/tenants/t1/deployments/d1/export?database=x',
      '/api/v1/tenants/t1/deployments/d1/import-from-file',
      '/api/v1/tenants/t1/deployments/d1/databases',
      '/api/v1/tenants/t1/deployments/d1/queryx',
      '/api/v1/tenants/t1/deployments/d1/x/query',
      '/api/v1/tenants/t1/sqlite/tables?file_path=a.db',
      '/api/v1/tenants/t1/sqlite/table-data?file_path=a.db',
      '/api/v1/tenants/t1/files/write',
      // REQUEST_URI carries the query string: these reach /tenants/t1 and
      // /tenants/t1/deployments/d1, with the rest as a query string.
      '/api/v1/tenants/t1?/sqlite/query',
      '/api/v1/tenants/t1?/deployments/d1/query',
      '/api/v1/tenants/t1/deployments/d1?/query',
      '/api/v1/tenants/t1;x/sqlite/query',
    ]) {
      expect(scope.test(uri), `${uri} must stay inspected`).toBe(false);
    }
  });

  it('the two routes parse an octet-stream body, in a scope of their own', () => {
    for (const [file, route] of [
      ['backend/src/modules/deployments/routes.ts', "scope.post('/tenants/:tenantId/deployments/:id/query'"],
      ['backend/src/modules/sqlite/routes.ts', "scope.post('/tenants/:tenantId/sqlite/query'"],
    ] as const) {
      const src = read(file);
      const at = src.indexOf(route);
      expect(at, `${route} in ${file}`).toBeGreaterThan(-1);
      // The parser registration is the statement just before the route, inside the same app.register.
      const before = src.slice(src.lastIndexOf('await app.register(async (scope) => {', at), at);
      expect(before).toContain('registerRawBodyParser(scope);');
    }
  });
});
