/**
 * The panels' route tables, read from source, and a matcher for links.
 *
 * Used by the link guard (modules/ui-links/link-targets.test.ts). A wrong link
 * fails INVISIBLY in a SPA — "Page Not Found", or a tab that silently falls back
 * to the default view — so every link the platform emits is checked against the
 * route table of the panel that renders it.
 *
 * Read from App.tsx and routes/tabbed-pages.ts as TEXT, never from a hand-kept
 * list: a renamed route or tab then breaks a test instead of a link.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Panel = 'admin' | 'tenant';

export interface RouteEntry {
  /** Full pattern, e.g. `/tenants/:id/:tab?`. */
  readonly pattern: string;
  /** `<Navigate to>` target when the route only redirects. */
  readonly redirectTo: string | null;
  /** The `<Route …>` tag as written — its element, for structural checks. */
  readonly tag: string;
}

export interface PanelRoutes {
  readonly panel: Panel;
  readonly routes: readonly RouteEntry[];
  /** routes/tabbed-pages.ts: page pattern → its tabs (first = default). */
  readonly tabs: ReadonlyMap<string, readonly string[]>;
  /**
   * Path prefixes served OUTSIDE the SPA on this panel's host — nginx
   * locations and Traefik IngressRoutes (vmui at /metrics/, the API). A link
   * there is a real page the SPA's router never sees.
   */
  readonly serverPaths: readonly string[];
}

/** Stands in for a `${…}` interpolation: a value only known at runtime. */
export const PLACEHOLDER = '__param__';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Read one tag starting at `start` (`<Route…`), honouring `{…}` and quotes. */
function readTag(src: string, start: number): { tag: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return { tag: src.slice(start, j + 1), end: j + 1 };
  }
  throw new Error(`unterminated <Route at offset ${start}`);
}

/**
 * Every route in an App.tsx, with its full pattern. Child routes are written
 * relative to their parent, so nesting is tracked; a tag may span lines.
 */
export function parseRouteTable(src: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('</Route>', i)) {
      stack.pop();
      i += '</Route>'.length;
      continue;
    }
    if (src.startsWith('<Route', i) && /[\s/>]/.test(src[i + 6] ?? '')) {
      const { tag, end } = readTag(src, i);
      const selfClosing = /\/\s*>$/.test(tag);
      const path = /^<Route[\s\S]*?\spath=["']([^"']*)["']/.exec(tag)?.[1];
      const isIndex = /^<Route\s+index\b/.test(tag);
      const redirectTo = /element=\{\s*<Navigate\s+to=["']([^"']+)["']/.exec(tag)?.[1] ?? null;

      const segment = path ?? '';
      const parents = segment.startsWith('/') ? [] : stack;
      const pattern = `/${[...parents, segment].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
      if (path !== undefined || isIndex) out.push({ pattern, redirectTo, tag });
      if (!selfClosing) stack.push(segment.startsWith('/') ? segment.replace(/^\/+/, '') : segment);
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

/** routes/tabbed-pages.ts → page pattern → tabs. */
export function parseTabbedPages(src: string): Map<string, string[]> {
  const body = /export const TABBED_PAGES = \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
  const out = new Map<string, string[]>();
  for (const m of body.matchAll(/'(\/[^']*)':\s*\[([\s\S]*?)\]/g)) {
    out.set(m[1]!, [...m[2]!.matchAll(/'([^']+)'/g)].map((t) => t[1]!));
  }
  return out;
}

/** Literal-prefix nginx locations other than the SPA catch-all `/`. */
export function parseNginxPrefixes(conf: string): string[] {
  return [...conf.matchAll(/^\s*location\s+(?:=\s*|\^~\s*)?(\/[^\s{]+)\s*\{/gm)].map((m) => m[1]!);
}

/** `Path`/`PathPrefix` rules of IngressRoutes whose match names `host`. */
export function parseIngressPrefixes(yaml: string, host: string): string[] {
  const out: string[] = [];
  for (const m of yaml.matchAll(/match:\s*"([^"\n]*)"/g)) {
    if (!m[1]!.includes(`Host(\`${host}\`)`)) continue;
    for (const p of m[1]!.matchAll(/Path(?:Prefix)?\(`(\/[^`]+)`\)/g)) out.push(p[1]!);
  }
  return out;
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return yamlFiles(p);
    return /\.ya?ml$/.test(e.name) ? [p] : [];
  });
}

export function loadPanel(panel: Panel): PanelRoutes {
  const dir = join(REPO_ROOT, 'frontend', `${panel}-panel`);
  const host = `${panel}.\${DOMAIN}`;
  const ingress = yamlFiles(join(REPO_ROOT, 'k8s', 'base'))
    .flatMap((f) => parseIngressPrefixes(readFileSync(f, 'utf8'), host));
  return {
    panel,
    routes: parseRouteTable(readFileSync(join(dir, 'src', 'App.tsx'), 'utf8')),
    tabs: parseTabbedPages(readFileSync(join(dir, 'src', 'routes', 'tabbed-pages.ts'), 'utf8')),
    serverPaths: [...parseNginxPrefixes(readFileSync(join(dir, 'nginx.conf.template'), 'utf8')), ...ingress],
  };
}

interface Match {
  readonly route: RouteEntry;
  readonly params: Readonly<Record<string, string>>;
}

/** A pattern with an optional last segment (`:tab?`) is two patterns. */
function variants(pattern: string): string[][] {
  const segs = pattern.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (last?.endsWith('?')) return [segs.slice(0, -1), [...segs.slice(0, -1), last.slice(0, -1)]];
  return [segs];
}

/** The route a pathname lands on, the way React Router ranks them: static over dynamic. */
export function matchRoute(routes: readonly RouteEntry[], pathname: string): Match | null {
  const parts = pathname.split('/').filter(Boolean);
  let best: { match: Match; score: number } | null = null;
  for (const route of routes) {
    if (route.pattern.includes('*')) continue; // the catch-all IS "Page Not Found"
    for (const segs of variants(route.pattern)) {
      if (segs.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let score = 0;
      let ok = true;
      for (let k = 0; k < segs.length; k++) {
        const seg = segs[k]!;
        const part = decodeURIComponent(parts[k]!);
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = part;
          score += 1;
        } else if (seg === part) {
          score += 3;
        } else if (part === PLACEHOLDER) {
          score += 0; // a runtime value could be this literal
        } else {
          ok = false;
          break;
        }
      }
      if (ok && (!best || score > best.score)) best = { match: { route, params }, score };
    }
  }
  return best?.match ?? null;
}

/**
 * Why `href` is a dead link in `panel`, or null when it resolves. External
 * links (`https://`, `//`, `mailto:`) are not this guard's business.
 */
export function checkLink(panel: PanelRoutes, href: string, depth = 0): string | null {
  if (!href.startsWith('/') || href.startsWith('//')) return null;
  const [beforeHash] = href.split('#');
  const [pathname, query = ''] = beforeHash!.split('?');
  if (panel.serverPaths.some((p) => pathname === p.replace(/\/$/, '') || pathname!.startsWith(p.endsWith('/') ? p : `${p}/`))) {
    return null;
  }
  const m = matchRoute(panel.routes, pathname!);
  if (!m) return `no ${panel.panel}-panel route matches ${pathname}`;
  if (m.route.redirectTo && depth < 3) {
    const target = m.route.redirectTo + (query ? (m.route.redirectTo.includes('?') ? '&' : '?') + query : '');
    const why = checkLink(panel, target, depth + 1);
    return why ? `${pathname} redirects to ${m.route.redirectTo}, and ${why}` : null;
  }
  const base = m.route.pattern.replace(/\/:tab\?$/, '');
  const tabs = panel.tabs.get(base);
  const queryTab = new URLSearchParams(query).get('tab');
  const tab = m.params.tab ?? queryTab;
  if (tabs) {
    if (tab && !tab.includes(PLACEHOLDER) && !tabs.includes(tab)) {
      return `${base} has no tab "${tab}" (tabs: ${tabs.join(', ')})`;
    }
  } else if (queryTab) {
    return `?tab=${queryTab} on ${pathname}, a page with no tabs — it would be ignored`;
  }
  return null;
}

/** `${…}` → PLACEHOLDER, so a template literal can be matched like a path. */
export function normaliseTemplate(raw: string): string {
  return raw.replace(/\$\{[^}]*\}/g, PLACEHOLDER);
}

/**
 * In-app link literals in frontend source: JSX `to=`/`href=`, `navigate()`,
 * `window.location`, and `to:`/`href:`/`actionPath:` object properties.
 * A template whose FIRST segment is interpolated cannot be checked and is skipped.
 */
export function extractFrontendLinks(src: string): string[] {
  const out: string[] = [];
  const lit = String.raw`(?:'(\/[^'\n]*)'|"(\/[^"\n]*)"|\`(\/(?:[^\`$\\]|\\.|\$\{[^}]*\})*)\`)`;
  const res = [
    new RegExp(String.raw`\b(?:to|href)=\{?\s*${lit}`, 'g'),
    new RegExp(String.raw`\bnavigate\(\s*${lit}`, 'g'),
    new RegExp(String.raw`\bwindow\.location(?:\.href)?\s*=\s*${lit}`, 'g'),
    new RegExp(String.raw`\bwindow\.location\.(?:assign|replace)\(\s*${lit}`, 'g'),
    new RegExp(String.raw`\b(?:to|href|actionPath)\s*:\s*${lit}`, 'g'),
  ];
  for (const re of res) {
    for (const m of src.matchAll(re)) {
      const raw = m[1] ?? m[2] ?? m[3]!;
      if (/^\/\$\{/.test(raw) || raw.startsWith('/api/') || raw === '/api') continue;
      out.push(normaliseTemplate(raw));
    }
  }
  return out;
}

/**
 * Source without comments (prose that mentions a path is not a link).
 * String-aware: a `//` or `/*` inside a quoted or template string is content,
 * not a comment — stripping it would hide the rest of that line from the guard.
 */
export function stripComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i++; } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * The expression starting at `from`, up to the `,` / `}` / `)` that ends it —
 * or, with `wholeList`, up to the `)` that closes an argument list.
 */
function expressionAt(src: string, from: number, wholeList = false): string {
  let depth = 0;
  let quote: string | null = null;
  for (let j = from; j < src.length; j++) {
    const c = src[j]!;
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return src.slice(from, j);
      depth--;
    } else if (c === ',' && depth === 0 && !wholeList) return src.slice(from, j);
  }
  return src.slice(from);
}

/** Path literals in an expression (quoted or template), API routes excluded. */
export function pathLiterals(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/'(\/[^'\s]*)'|`(\/(?:[^`$\s]|\$\{[^}]*\})*)`/g)) {
    const raw = m[1] ?? m[2]!;
    if (raw.startsWith('/api/')) continue;
    out.push(normaliseTemplate(raw));
  }
  return out;
}

export interface EmittedLink {
  /** Set when the source says which panel the link is for (panelRoute keys). */
  readonly panel: Panel | null;
  readonly href: string;
}

/**
 * Links a backend file emits: the values of `href:` / `actionPath:` (ternaries
 * included), and the `admin:` / `tenant:` targets of `panelRoute(…)`, which
 * carry their own panel.
 */
export function extractEmittedLinks(source: string): EmittedLink[] {
  const src = stripComments(source);
  const out: EmittedLink[] = [];
  for (const m of src.matchAll(/\bpanelRoute\(/g)) {
    const args = expressionAt(src, m.index! + m[0].length, true);
    for (const k of args.matchAll(/\b(admin|tenant)\s*:\s*/g)) {
      for (const href of pathLiterals(expressionAt(args, k.index! + k[0].length))) {
        out.push({ panel: k[1] as Panel, href });
      }
    }
  }
  for (const m of src.matchAll(/\b(?:href|actionPath)\s*:\s*/g)) {
    for (const href of pathLiterals(expressionAt(src, m.index! + m[0].length))) out.push({ panel: null, href });
  }
  return out;
}
