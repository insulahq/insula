import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkLink,
  extractEmittedLinks,
  extractFrontendLinks,
  loadPanel,
  stripComments,
  type Panel,
  type PanelRoutes,
} from '../../test-helpers/ui-routes.js';

/**
 * Every link the platform renders must land on a real page — and on a real TAB.
 *
 * A wrong link fails INVISIBLY in a SPA: "Page Not Found", or a tab that does
 * not exist and silently falls back to the page's default view. Nobody reports
 * either; the notification or the tile looked fine. The admin dashboard's SLO
 * tile linked to `/monitoring/slo` (the tab is `slos`); notifications linked to
 * `/settings/storage` and `/dashboard`, which no panel has ever had.
 *
 * Checked against the route table of the panel that RENDERS the link — the
 * panels are separate apps, and `/domains` exists in only one of them.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const BACKEND_SRC = join(ROOT, 'backend', 'src');
const PANELS: Record<Panel, PanelRoutes> = { admin: loadPanel('admin'), tenant: loadPanel('tenant') };

interface Problem { readonly where: string; readonly href: string; readonly why: string }

function check(where: string, href: string, panels: readonly Panel[]): Problem[] {
  return panels.flatMap((p) => {
    const why = checkLink(PANELS[p], href);
    return why ? [{ where: `${where} [${p}]`, href, why }] : [];
  });
}

function sourceFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'test-helpers') continue;
      out.push(...sourceFiles(p, exts));
    } else if (exts.some((x) => e.name.endsWith(x)) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function report(problems: readonly Problem[]): string {
  return problems.map((p) => `\n  ${p.where}: ${p.href} — ${p.why}`).join('');
}

// ─── The panels' own links ────────────────────────────────────────────────────

describe('frontend links', () => {
  for (const panel of ['admin', 'tenant'] as const) {
    it(`every in-app link in the ${panel} panel lands on a real page and tab`, () => {
      const srcDir = join(ROOT, 'frontend', `${panel}-panel`, 'src');
      const files = sourceFiles(srcDir, ['.ts', '.tsx']);
      let seen = 0;
      const problems = files.flatMap((f) => {
        const links = extractFrontendLinks(stripComments(readFileSync(f, 'utf8')));
        seen += links.length;
        return links.flatMap((href) => check(relative(ROOT, f), href, [panel]));
      });
      // Parser sanity: an extractor that stops matching would pass forever.
      expect(seen).toBeGreaterThan(50);
      expect(problems, report(problems)).toEqual([]);
    });
  }
});

// ─── Links the backend emits ──────────────────────────────────────────────────

/**
 * Every backend file that emits a panel link — dashboard tiles, tenant-issue
 * chips, task-center targets — and the panel(s) whose users see it. A file that
 * emits links and is NOT listed fails the guard: say who renders it.
 *
 * Links are the values of `href:` / `actionPath:`. `panelRoute(scope, { admin,
 * tenant })` targets carry their own panel and are checked there. `split`
 * divides a file whose first part feeds one panel and the rest another.
 */
type Audience = readonly Panel[] | { readonly split: string; readonly before: readonly Panel[]; readonly after: readonly Panel[] };

const EMITTERS: Record<string, Audience> = {
  // Dashboard tiles.
  'modules/dashboard/alerts.ts': { split: 'export async function buildTenantAlerts', before: ['admin'], after: ['tenant'] },
  'modules/dashboard/cluster-alerts.ts': ['admin'],
  'modules/dashboard/cpu-reservation.ts': ['admin'],
  // Tenant-issue chips: the admin tenants list and tenant page.
  'modules/tenant-issues/service.ts': ['admin'],
  // Task-center targets: the chip renders in the panel of whoever started the task.
  'modules/backup-rclone-shim/apply-assignment.ts': ['admin'],
  'modules/backup-restore/routes.ts': ['admin'],
  'modules/certificates/reissue.ts': ['tenant'], // an admin start opens a modal instead
  'modules/cpu-migration/runner.ts': ['admin'],
  'modules/domains/routes.ts': [], // panelRoute targets only
  'modules/mail-admin/archive.ts': ['admin'],
  'modules/mail-admin/routes.ts': ['admin'],
  'modules/storage/routes.ts': ['admin'],
  'modules/system-backup/service.ts': ['admin'],
  'modules/tenant-snapshots/routes.ts': ['tenant'], // an admin start opens a modal instead
};

/** Notification links and search results are evaluated by running the real code, below. */
const EVALUATED_ELSEWHERE = new Set(['modules/notifications/action-path.ts', 'modules/notifications/action-links.ts', 'modules/search/providers.ts']);

describe('backend links', () => {
  const files = sourceFiles(BACKEND_SRC, ['.ts']).map((f) => relative(BACKEND_SRC, f).replace(/\\/g, '/'));

  it('every file that emits a panel link says which panel renders it', () => {
    const undeclared = files.filter((f) => !EMITTERS[f] && !EVALUATED_ELSEWHERE.has(f)
      && extractEmittedLinks(readFileSync(join(BACKEND_SRC, f), 'utf8')).length > 0);
    expect(undeclared, `declare these in EMITTERS: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('every emitted link lands on a real page and tab in its panel', () => {
    const problems: Problem[] = [];
    let seen = 0;
    for (const [file, audience] of Object.entries(EMITTERS)) {
      const src = readFileSync(join(BACKEND_SRC, file), 'utf8');
      const parts: Array<[string, readonly Panel[]]> = Array.isArray(audience)
        ? [[src, audience as readonly Panel[]]]
        : (() => {
            const a = audience as Exclude<Audience, readonly Panel[]>;
            const at = src.indexOf(a.split);
            if (at < 0) throw new Error(`${file}: split marker "${a.split}" not found`);
            return [[src.slice(0, at), a.before], [src.slice(at), a.after]];
          })();
      for (const [text, panels] of parts) {
        for (const link of extractEmittedLinks(text)) {
          seen++;
          problems.push(...check(`backend/src/${file}`, link.href, link.panel ? [link.panel] : panels));
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(problems, report(problems)).toEqual([]);
  });

  it('the targets that shipped broken stay fixed', () => {
    // Regression anchors, named so a re-introduction is obvious.
    const alerts = readFileSync(join(BACKEND_SRC, 'modules/dashboard/alerts.ts'), 'utf8');
    expect(alerts).not.toContain("'/monitoring/slo'");
    const statics = readFileSync(join(BACKEND_SRC, 'modules/notifications/action-path.ts'), 'utf8');
    expect(statics).not.toContain("'/settings/storage'");
    expect(statics).not.toContain("'/dashboard'");
  });
});

// ─── Notifications ────────────────────────────────────────────────────────────

/** Delivered to users of BOTH panels — a password change happens in either. */
const BOTH_PANELS = new Set(['security.password_changed', 'security.password_reset']);

describe('notification links', () => {
  it('every category opens a real page and tab in the panel of its audience', async () => {
    const { ALL_CATEGORIES } = await import('../notifications/categories/seed.js');
    const { linkPathsFor } = await import('../notifications/action-links.js');
    const { RESOURCE_PATHS } = await import('../notifications/action-path.js');
    const problems: Problem[] = [];
    let seen = 0;
    for (const cat of ALL_CATEGORIES) {
      const panels: readonly Panel[] = BOTH_PANELS.has(cat.id) ? ['admin', 'tenant'] : [cat.audience === 'admin' ? 'admin' : 'tenant'];
      // With and without a resource: deep links differ from list links. Plus
      // every resource a category routes on its own (mail drift → Data Drift).
      for (const resource of [
        { resourceType: null, resourceId: null, tenantId: null },
        { resourceType: 'tenant', resourceId: '11111111-2222-4333-8444-555555555555', tenantId: '11111111-2222-4333-8444-555555555555' },
        ...Object.keys(RESOURCE_PATHS[cat.id] ?? {}).map((resourceType) => ({ resourceType, resourceId: null, tenantId: null })),
      ]) {
        for (const link of linkPathsFor({ categoryId: cat.id, ...resource })) {
          seen++;
          problems.push(...check(`notification ${cat.id} "${link.text}"`, link.path, panels));
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
    expect(problems, report(problems)).toEqual([]);
  });
});

// ─── Global search results ────────────────────────────────────────────────────

/**
 * A database stand-in for search providers: any query chain resolves to one
 * row whose every column is a placeholder id. Enough to run each provider's
 * real row → link mapping, per panel, without a database.
 */
function fakeDb(): unknown {
  const row = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : 'x1') });
  const result = Object.assign([row], { rows: [row] });
  const chain: unknown = new Proxy(function chainFn() {}, {
    get: (_t, prop) => (prop === 'then' ? (resolve: (v: unknown) => void) => resolve(result) : () => chain),
    apply: () => chain,
  });
  return chain;
}

describe('search result links', () => {
  it('every provider links to a real page in each panel it serves', async () => {
    const { SEARCH_PROVIDERS } = await import('../search/providers.js');
    const problems: Problem[] = [];
    let seen = 0;
    for (const provider of SEARCH_PROVIDERS) {
      for (const panel of provider.panels) {
        const ctx = { panel, tenantId: panel === 'tenant' ? 'x1' : undefined } as never;
        const items = await provider.run(fakeDb() as never, ctx, 'q', 5);
        for (const item of items) {
          seen++;
          problems.push(...check(`search provider ${provider.type}`, item.href, [panel]));
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(problems, report(problems)).toEqual([]);
  });
});

// ─── The tab registry and the route table agree ───────────────────────────────

describe('tabbed pages', () => {
  for (const panel of ['admin', 'tenant'] as const) {
    it(`${panel}: every tabbed page is routed as <page>/:tab?, and no tab is shadowed by a page`, () => {
      const { routes, tabs } = PANELS[panel];
      const patterns = new Set(routes.map((r) => r.pattern));
      const problems: string[] = [];
      for (const [page, ids] of tabs) {
        if (!patterns.has(`${page}/:tab?`)) problems.push(`${page} has tabs but no "${page}/:tab?" route`);
        for (const id of ids) {
          if (patterns.has(`${page}/${id}`)) problems.push(`${page}/${id} is a page of its own — the "${id}" tab is unreachable by path`);
        }
        // useTabParam reads the last path segment as a tab when a page is
        // mounted without `:tab?`; that is only safe while no page path ends
        // in one of its own tab ids.
        const last = page.split('/').pop() ?? '';
        if ((ids as readonly string[]).includes(last)) problems.push(`${page} ends in its own tab id "${last}"`);
      }
      for (const r of routes) {
        const base = r.pattern.replace(/\/:tab\?$/, '');
        if (base === r.pattern) continue;
        if (!tabs.has(base)) problems.push(`${r.pattern} takes a tab but ${base} is not in routes/tabbed-pages.ts`);
        // TabRoute canonicalises the URL before the page mounts; without it a
        // page's own mount-time URL writes race the rewrite.
        if (!r.tag.includes(`<TabRoute page="${base}">`)) problems.push(`${r.pattern} does not render its page inside <TabRoute page="${base}">`);
      }
      expect(tabs.size).toBeGreaterThan(0);
      expect(problems).toEqual([]);
    });
  }
});
