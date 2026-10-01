/**
 * Traefik's per-route service label, computed forward from a live
 * IngressRoute.
 *
 * Traefik's counters carry one identifying label, `service`, and for a route
 * of the kubernetescrd provider it is
 *
 *     normalize(<namespace>-<IngressRoute name>-<hex(sha256(route.match))[:20]>)@kubernetescrd
 *
 * (`makeServiceKey` + `makeID` + `provider.Normalize` in Traefik's CRD
 * provider; `%.10x` over the digest is its first ten BYTES, twenty hex).
 * The hash cannot be inverted, but it does not need to be: hashing every
 * LIVE rule and looking the label up names the series exactly. Verified on
 * production against a week of labels — every miss was a cert-manager solver
 * or a rule that had since changed.
 *
 * The rule must be the literal string the cluster holds. Rebuilding it from
 * the database is not a substitute: a one-character difference produces a
 * different hash that silently matches nothing.
 */

import { createHash } from 'node:crypto';

export const TRAEFIK_CRD_PROVIDER = 'kubernetescrd';
const RULE_HASH_HEX = 20;

/** One route of one live IngressRoute object. */
export interface LiveRoute {
  readonly namespace: string;
  readonly objectName: string;
  readonly entryPoints: readonly string[];
  /** The literal match rule, exactly as stored in the cluster. */
  readonly match: string;
  /** `services[0].name` — the Kubernetes Service the route forwards to. */
  readonly backendService: string | null;
}

/** Traefik's `provider.Normalize`: each run of non-alphanumerics → one `-`. */
export function normalizeTraefikName(name: string): string {
  return name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).join('-');
}

export function traefikRuleHash(match: string): string {
  return createHash('sha256').update(match).digest('hex').slice(0, RULE_HASH_HEX);
}

export function traefikServiceLabel(namespace: string, objectName: string, match: string): string {
  const id = normalizeTraefikName(`${namespace}-${objectName}-${traefikRuleHash(match)}`);
  return `${id}@${TRAEFIK_CRD_PROVIDER}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function routesOfObject(item: unknown): LiveRoute[] {
  if (!isRecord(item) || !isRecord(item.metadata) || !isRecord(item.spec)) return [];
  const namespace = str(item.metadata.namespace);
  const objectName = str(item.metadata.name);
  if (!namespace || !objectName || !Array.isArray(item.spec.routes)) return [];
  const entryPoints = Array.isArray(item.spec.entryPoints)
    ? item.spec.entryPoints.filter((e): e is string => typeof e === 'string')
    : [];
  return item.spec.routes.flatMap((r): LiveRoute[] => {
    if (!isRecord(r)) return [];
    const match = str(r.match);
    if (!match) return [];
    const first = Array.isArray(r.services) ? r.services[0] : undefined;
    const backendService = isRecord(first) ? str(first.name) : null;
    return [{ namespace, objectName, entryPoints, match, backendService }];
  });
}

/**
 * Every route of every IngressRoute in a Kubernetes list body. The body is
 * external input, so anything malformed is skipped rather than trusted.
 */
export function liveRoutesFromList(body: unknown): LiveRoute[] {
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  return body.items.flatMap(routesOfObject);
}

/** label → route, keyed exactly as Traefik labels the route's series. */
export function indexLiveRoutes(routes: readonly LiveRoute[]): Map<string, LiveRoute> {
  return new Map(routes.map((r) => [traefikServiceLabel(r.namespace, r.objectName, r.match), r]));
}

// ─── Reading a rule back ──────────────────────────────────────────────

export interface ParsedRule {
  /** Every host the rule names, in order; a wildcard reads `*.<base>`. */
  readonly hosts: readonly string[];
  /** The PathPrefix()/Path() narrowing, or null for none. Used to match route rows. */
  readonly path: string | null;
  /**
   * What narrows the host, for a person: the path, a PathRegexp read as a
   * pattern, and the method. Null when the rule is the host alone.
   */
  readonly label: string | null;
}

// No nested quantifier: the call body is taken whole, its arguments picked
// out after — a hostname never contains `)`, and this stays linear on junk.
const HOST_CALL_RE = /\bHost\(([^)]*)\)/g;
const BACKTICK_ARG_RE = /`([^`]*)`/g;
const HOST_REGEXP_RE = /\bHostRegexp\(\s*`([^`]*)`\s*\)/g;
const PATH_RE = /\b(?:PathPrefix|Path)\(\s*`([^`]*)`\s*\)/;
const PATH_REGEXP_RE = /\bPathRegexp\(\s*`([^`]*)`\s*\)/;
const METHOD_RE = /\bMethod\(\s*`([^`]*)`\s*\)/;
const GROUP_RE = /\([^()]*\)/g;

/**
 * A PathRegexp as a pattern a person can scan:
 * `^/api/v1/tenants/[^/]+/files/upload-raw$` reads as `/api/v1/tenants/` + a star + `/files/upload-raw`.
 * Anchors go, `[^/]+` is `*`, `.+` is `**`, and a group of alternatives —
 * which has no short honest reading — folds to `…`.
 */
export function readablePathRegexp(re: string): string {
  let s = re.replace(/^\^/, '').replace(/\$$/, '');
  // Innermost groups first, so nested alternatives fold to one ellipsis.
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(GROUP_RE, '…');
  }
  return s
    .replace(/\[\^\/\]\+/g, '*')
    .replace(/\.[+*]/g, '**')
    .replace(/\\(.)/g, '$1')
    .replace(/…+/g, '…');
}
/** What `hostMatch()` emits for `*.<base>`: one label, case-insensitive. */
const PLATFORM_WILDCARD_RE = /^\(\?i\)\^\[\^\.\]\+\\\.(.+)\$$/;

/** `(?i)^[^.]+\.example\.test$` → `*.example.test`; anything else → null. */
function wildcardFromRegexp(re: string): string | null {
  const m = PLATFORM_WILDCARD_RE.exec(re);
  if (!m) return null;
  const base = m[1].replace(/\\(.)/g, '$1');
  // Only a plain hostname survives unescaping; a real regexp is not guessed at.
  return /^[a-z0-9.-]+$/i.test(base) ? `*.${base}` : null;
}

/** Host(s) and path out of a match rule, in the shapes the platform emits. */
export function parseMatchRule(match: string): ParsedRule | null {
  const found: Array<{ at: number; host: string }> = [];
  for (const m of match.matchAll(HOST_CALL_RE)) {
    for (const arg of m[1].matchAll(BACKTICK_ARG_RE)) {
      if (arg[1]) found.push({ at: (m.index ?? 0) + (arg.index ?? 0), host: arg[1] });
    }
  }
  for (const m of match.matchAll(HOST_REGEXP_RE)) {
    const host = wildcardFromRegexp(m[1]);
    if (host) found.push({ at: m.index ?? 0, host });
  }
  if (found.length === 0) return null;
  const hosts = [...new Set([...found].sort((a, b) => a.at - b.at).map((f) => f.host))];
  const path = PATH_RE.exec(match)?.[1] ?? null;
  const regexp = PATH_REGEXP_RE.exec(match)?.[1] ?? null;
  const method = METHOD_RE.exec(match)?.[1] ?? null;
  const shown = path ?? (regexp !== null ? readablePathRegexp(regexp) : null);
  const label = [shown, method].filter((x): x is string => Boolean(x)).join(' ') || null;
  return { hosts, path, label };
}
