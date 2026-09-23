import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every notification action link must resolve to a route that exists.
 *
 * A wrong path fails INVISIBLY: the SPA renders its not-found (or nothing),
 * and nobody reports it because the notification looked fine. The audit that
 * prompted this found two dead targets shipping in production —
 * `/settings/storage`, which no panel has ever had, and `/dashboard`, when
 * both dashboards are the INDEX route at `/`.
 *
 * Parsed from App.tsx rather than a hand-kept list, so a renamed route breaks
 * this test instead of a notification.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');

function routeSegments(panel: string): Set<string> {
  const src = readFileSync(join(ROOT, 'frontend', panel, 'src', 'App.tsx'), 'utf8');
  return new Set([...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]));
}

function resolves(target: string, table: Set<string>): boolean {
  const seg = target.replace(/^\//, '');
  if (seg === '') return true; // the index route
  if (table.has(seg) || table.has(target)) return true;
  if (seg.includes('/')) {
    const [parent, ...rest] = seg.split('/');
    return table.has(parent) && table.has(rest.join('/'));
  }
  return false;
}

describe('notification action paths point at real routes', () => {
  const admin = routeSegments('admin-panel');
  const tenant = routeSegments('tenant-panel');

  const paths = (() => {
    const src = readFileSync(
      join(__dirname, 'action-path.ts'),
      'utf8',
    );
    return [...new Set([...src.matchAll(/'(\/[a-z0-9/_.-]*)'/g)].map((m) => m[1]))];
  })();

  it('found paths to check', () => {
    expect(paths.length).toBeGreaterThan(10);
  });

  it('every path resolves in at least one panel', () => {
    const dead = paths.filter((p) => !resolves(p, admin) && !resolves(p, tenant));
    expect(dead, `dead notification targets: ${dead.join(', ')}`).toEqual([]);
  });

  it('the two that shipped broken stay fixed', () => {
    // Regression anchors, named so a re-introduction is obvious.
    expect(paths).not.toContain('/settings/storage');
    expect(paths).not.toContain('/dashboard');
  });
});
