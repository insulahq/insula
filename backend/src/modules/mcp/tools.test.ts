/**
 * Agents and the platform cannot drift apart: every operation IS a route
 * (catalog.ts), and the only hand-written references — the core tools and the
 * exclusion rules — are checked here against the routes actually registered in
 * the source tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_TOOLS } from './tools.js';
import { EXCLUSIONS, normalizeKey } from './catalog.js';

const SRC = join(import.meta.dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** Every `app.<method>('<path>'` in the backend — the routes as written. */
function routesInSource(): Set<string> {
  const keys = new Set<string>();
  for (const file of [...walk(join(SRC, 'modules')), join(SRC, 'app.ts')]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      keys.add(normalizeKey(`${m[1].toUpperCase()} ${m[2]}`));
    }
  }
  return keys;
}

const routes = routesInSource();

describe('core tools', () => {
  it('each runs a route that exists', () => {
    const missing = CORE_TOOLS.filter((t) => !routes.has(normalizeKey(t.operation))).map((t) => `${t.name} → ${t.operation}`);
    expect(missing).toEqual([]);
  });

  it('have unique, MCP-safe names', () => {
    const names = CORE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
  });

  it('none of them is an excluded route', () => {
    const hit = CORE_TOOLS.filter((t) => EXCLUSIONS.some((e) => e.pattern.test(normalizeKey(t.operation).split(' ')[1])));
    expect(hit).toEqual([]);
  });
});

describe('exclusion rules', () => {
  it('each still matches at least one route — a stale rule hides nothing but itself', () => {
    const paths = [...routes].map((k) => k.split(' ')[1]);
    // The MCP endpoint and the OAuth routes are registered with their full path.
    const withAgentRoutes = [...paths, '/mcp', '/oauth/token'];
    const stale = EXCLUSIONS.filter((e) => !withAgentRoutes.some((p) => e.pattern.test(p))).map((e) => String(e.pattern));
    expect(stale).toEqual([]);
  });
});
