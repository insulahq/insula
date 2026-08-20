/**
 * Traefik IngressRoute + Middleware shape helpers.
 *
 * Replaces the prior nginx-ingress annotation-driven model. Each
 * Middleware is a separate CRD; an IngressRoute references them by name
 * inside `routes[].middlewares[]`. Tenant reconcilers emit a
 * `RouteSpec` per ingress_routes row; the spec carries both the
 * IngressRoute body and any companion Middleware bodies that need to
 * be applied side-by-side.
 *
 * The companion Middlewares have stable names derived from the route
 * id so reconciler runs are idempotent and orphan-cleanup can target
 * exact names without label scans.
 *
 * `traefik.io/v1alpha1` is the only API version Traefik v3.7 ("Langres")
 * accepts for these CRDs.
 */

import {
  isWildcardHostname,
  labelCount,
  normalizeHostname,
  wildcardBase,
} from '@insula/api-contracts';

export const TRAEFIK_GROUP = 'traefik.io';
export const TRAEFIK_VERSION = 'v1alpha1';
export const INGRESSROUTE_PLURAL = 'ingressroutes';
export const MIDDLEWARE_PLURAL = 'middlewares';
export const TLSOPTION_PLURAL = 'tlsoptions';

export const CERTMANAGER_GROUP = 'cert-manager.io';
export const CERTMANAGER_VERSION = 'v1';
export const CERTIFICATE_PLURAL = 'certificates';

export interface TraefikService {
  name: string;
  port: number;
  /** Optional kube-namespace override for cross-ns Service refs. */
  namespace?: string;
}

export interface TraefikRoute {
  match: string;
  kind: 'Rule';
  /** Higher = wins. Default = match-rule length. */
  priority?: number;
  /** Middlewares to apply BEFORE the route's services. Order matters. */
  middlewares?: Array<{ name: string; namespace?: string }>;
  services: TraefikService[];
}

export interface TraefikIngressRouteSpec {
  entryPoints: string[];
  routes: TraefikRoute[];
  tls?: {
    secretName?: string;
    options?: { name: string; namespace?: string };
  };
}

export interface MiddlewareBody {
  apiVersion: 'traefik.io/v1alpha1';
  kind: 'Middleware';
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  // The spec is one of many top-level kinds (forwardAuth, rateLimit,
  // redirectScheme, redirectRegex, ipWhiteList, basicAuth, headers,
  // chain, …). Typed loosely here — call sites are typed by the
  // builder functions.
  spec: Record<string, unknown>;
}

export interface IngressRouteBody {
  apiVersion: 'traefik.io/v1alpha1';
  kind: 'IngressRoute';
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: TraefikIngressRouteSpec;
}

export interface TLSOptionBody {
  apiVersion: 'traefik.io/v1alpha1';
  kind: 'TLSOption';
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
  };
  spec: {
    minVersion?: string;
    clientAuth?: {
      /** One of the TLSOption clientAuthType enum values. */
      clientAuthType: string;
      /** Names of Secrets (same namespace) carrying the CA bundle under `tls.ca`. */
      secretNames?: string[];
    };
  };
}

/**
 * Aggregate of what a single ingress_routes row produces in the
 * Traefik model. The reconciler:
 *   1. Applies every body in `middlewares[]` first (Middleware CRDs
 *      must exist before the IngressRoute that references them).
 *   2. Applies `ingressRoute` (one per host or per hostname-group).
 *   3. Reads `expectedMiddlewareNames` to compute orphan cleanup
 *      (Middleware CRDs no longer referenced by any RouteSpec for the
 *      same tenant get deleted).
 */
export interface RouteSpec {
  /** Hostname this spec services — for diagnostics + grouping. */
  hostname: string;
  /** Companion Middleware CRDs to apply before the IngressRoute. */
  middlewares: MiddlewareBody[];
  /** Middleware names this spec references (subset of middlewares[]). */
  expectedMiddlewareNames: string[];
  /** The IngressRoute body itself. */
  ingressRoute: IngressRouteBody;
}

// ─── Pure builders ─────────────────────────────────────────────────

const MANAGED_BY = 'platform-api';
const PART_OF = 'hosting-platform';

function defaultLabels(extra?: Record<string, string>): Record<string, string> {
  return {
    'app.kubernetes.io/part-of': PART_OF,
    'app.kubernetes.io/managed-by': MANAGED_BY,
    ...extra,
  };
}

export function buildMiddleware(args: {
  name: string;
  namespace: string;
  spec: Record<string, unknown>;
  labels?: Record<string, string>;
}): MiddlewareBody {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: {
      name: args.name,
      namespace: args.namespace,
      labels: defaultLabels(args.labels),
    },
    spec: args.spec,
  };
}

export function buildIngressRoute(args: {
  name: string;
  namespace: string;
  routes: TraefikRoute[];
  tls?: TraefikIngressRouteSpec['tls'];
  entryPoints?: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}): IngressRouteBody {
  // Defence-in-depth: refuse to emit a tenant-namespace IngressRoute
  // that points at a Service in a DIFFERENT namespace. Traefik's
  // controller is installed with allowCrossNamespace=true (required
  // so tenant routes can reference shared Middlewares in `traefik`),
  // which by itself ALSO allows cross-namespace Service refs in
  // routes[].services[]. The platform's own code paths never set an
  // explicit `services[].namespace`, so any non-empty namespace here
  // signals a future programming error (a hostile tenant whose route
  // was somehow allowed to point at platform-api would lift the
  // boundary). We assert at build time rather than rely on Traefik's
  // (permissive) validation.
  //
  // Exception: routes that DELIBERATELY cross namespaces (e.g. the
  // tunnel-anchor in platform-system referencing a tenant-namespace
  // Service via ExternalName) must opt out by setting
  // `services[].namespace` equal to the route's expected target.
  // The current codebase has no such case, so we treat any cross-ns
  // service ref as a bug.
  for (const route of args.routes) {
    for (const svc of route.services) {
      if (svc.namespace && svc.namespace !== args.namespace) {
        throw new Error(
          `IngressRoute ${args.namespace}/${args.name}: route service ${svc.name} declares cross-namespace ref (services[].namespace=${svc.namespace}), which is rejected by buildIngressRoute. Cross-namespace traffic should go through ExternalName Services or a Middleware ref instead.`,
        );
      }
    }
  }
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name: args.name,
      namespace: args.namespace,
      labels: defaultLabels(args.labels),
      ...(args.annotations ? { annotations: args.annotations } : {}),
    },
    spec: {
      entryPoints: args.entryPoints ?? ['websecure'],
      routes: args.routes,
      ...(args.tls ? { tls: args.tls } : {}),
    },
  };
}

/**
 * Map the platform's per-route mTLS `verify_mode` to a Traefik
 * `clientAuthType`. Traefik v3.7 OSS TLSOption supports CA verification
 * (this) but NOT CRL — revocation is enforced separately via a ForwardAuth
 * serial check (see ingress-mtls revocation path).
 *   on             → RequireAndVerifyClientCert (require + verify against CA)
 *   optional       → VerifyClientCertIfGiven    (verify if presented, else allow)
 *   optional_no_ca → RequestClientCert          (ask for a cert, don't verify)
 */
export function clientAuthTypeForVerifyMode(verifyMode: string): string {
  switch (verifyMode) {
    case 'optional':
      return 'VerifyClientCertIfGiven';
    case 'optional_no_ca':
      return 'RequestClientCert';
    case 'on':
    default:
      return 'RequireAndVerifyClientCert';
  }
}

/**
 * Build a TLSOption CR that enforces client-cert auth. `secretNames` point
 * at the CA-bundle Secret(s) (key `tls.ca`) materialised by annotation-sync;
 * an IngressRoute references this via `spec.tls.options`. TLSOption scope is
 * per-IngressRoute (per TLS listener) — mTLS hosts therefore live in their
 * own IngressRoute, never mixed with plain hosts.
 */
export function buildTLSOption(args: {
  name: string;
  namespace: string;
  clientAuthType: string;
  secretNames?: string[];
  labels?: Record<string, string>;
}): TLSOptionBody {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'TLSOption',
    metadata: {
      name: args.name,
      namespace: args.namespace,
      labels: defaultLabels(args.labels),
    },
    spec: {
      minVersion: 'VersionTLS12',
      clientAuth: {
        clientAuthType: args.clientAuthType,
        ...(args.secretNames && args.secretNames.length > 0
          ? { secretNames: args.secretNames }
          : {}),
      },
    },
  };
}

/**
 * Build a stable Middleware name from a route id + a suffix that
 * identifies the kind of middleware. Stable names let reconciles be
 * idempotent and orphan cleanup be deterministic.
 *
 * 8-char prefix of the route id keeps names within the K8s 63-char
 * limit even with long suffixes.
 */
export function middlewareName(routeId: string, suffix: string): string {
  return `r-${routeId.slice(0, 8)}-${suffix}`;
}

export type MiddlewareKind =
  | 'ratelimit'
  | 'ipallowlist'
  | 'redirectregex'
  | 'redirectscheme'
  | 'basicauth'
  | 'forwardauth'
  | 'headers'
  | 'stripprefix'
  | 'mtls';

// ─── Pure spec helpers ────────────────────────────────────────────────

export interface RateLimitArgs {
  /** Avg requests per second. Maps to nginx `limit-rps`. */
  average: number;
  /** Burst — additional queued requests before throttle kicks in. */
  burst: number;
}
export function rateLimitSpec(args: RateLimitArgs): Record<string, unknown> {
  return {
    rateLimit: {
      average: args.average,
      burst: args.burst,
    },
  };
}

/**
 * Concurrent-connection cap. Traefik's `inFlightReq` Middleware throttles
 * based on the number of simultaneous requests from one source IP. Maps
 * to the nginx `limit-connections` annotation we used to emit.
 */
export function inFlightReqSpec(amount: number): Record<string, unknown> {
  return {
    inFlightReq: {
      amount,
      // ipStrategy with no depth defaults to the immediate remote
      // address — matches nginx limit_conn's `$binary_remote_addr`
      // bucket key. Operators behind a known L4 LB can patch this to
      // `ipStrategy: { depth: 1 }` to read the X-Forwarded-For chain.
      sourceCriterion: { ipStrategy: {} },
    },
  };
}

export interface ErrorsArgs {
  /** HTTP status codes to intercept (e.g. ['404', '503'] or ['500-599']). */
  status: string[];
  /** Backend Service name to serve the error page. */
  serviceName: string;
  /** Service port. Default 80. */
  servicePort?: number;
  /** Cross-namespace ref override. Defaults to the IngressRoute's namespace. */
  serviceNamespace?: string;
  /** Path on the backend (Traefik's `query`). Default `/{status}.html`. */
  query?: string;
}

/**
 * `errors` Middleware — intercept upstream responses with status codes
 * matching `status` and serve content from a different Service instead.
 * Replaces the nginx `custom-http-errors` annotation + default-backend
 * pattern.
 */
export function errorsSpec(args: ErrorsArgs): Record<string, unknown> {
  return {
    errors: {
      status: args.status,
      service: {
        name: args.serviceName,
        port: args.servicePort ?? 80,
        ...(args.serviceNamespace ? { namespace: args.serviceNamespace } : {}),
      },
      query: args.query ?? '/{status}.html',
    },
  };
}

export function ipAllowListSpec(cidrs: string[]): Record<string, unknown> {
  return {
    ipAllowList: {
      sourceRange: cidrs,
    },
  };
}

export function redirectSchemeSpec(scheme: 'http' | 'https', permanent = true): Record<string, unknown> {
  return {
    redirectScheme: { scheme, permanent },
  };
}

export interface RedirectRegexArgs {
  regex: string;
  replacement: string;
  permanent?: boolean;
}
export function redirectRegexSpec(args: RedirectRegexArgs): Record<string, unknown> {
  return {
    redirectRegex: {
      regex: args.regex,
      replacement: args.replacement,
      permanent: args.permanent ?? false,
    },
  };
}

/**
 * Basic-auth Middleware backed by a K8s Secret in the same namespace.
 * The Secret must contain a key `users` with htpasswd-format content
 * (one user per line, password hashed with bcrypt/$2y$).
 */
export function basicAuthSpec(secretName: string, realm?: string): Record<string, unknown> {
  return {
    basicAuth: {
      secret: secretName,
      ...(realm ? { realm } : {}),
    },
  };
}

export interface ForwardAuthArgs {
  address: string;
  trustForwardHeader?: boolean;
  authResponseHeaders?: string[];
  authRequestHeaders?: string[];
}
export function forwardAuthSpec(args: ForwardAuthArgs): Record<string, unknown> {
  return {
    forwardAuth: {
      address: args.address,
      // Default to FALSE — Traefik's entrypoint-level trustedIPs (set
      // to 127.0.0.1/32 by bootstrap.sh) already strips attacker-
      // supplied XFF before any Middleware runs. Trusting incoming
      // XFF at the ForwardAuth level would re-introduce the spoof
      // vector. Callers wiring an internal-only ForwardAuth (e.g. a
      // sidecar reachable only via cluster DNS) can opt into
      // trusting upstream headers by setting trustForwardHeader: true
      // explicitly, AFTER auditing the call path.
      trustForwardHeader: args.trustForwardHeader ?? false,
      ...(args.authResponseHeaders ? { authResponseHeaders: args.authResponseHeaders } : {}),
      ...(args.authRequestHeaders ? { authRequestHeaders: args.authRequestHeaders } : {}),
    },
  };
}

export interface HeadersArgs {
  /** Custom request headers added before forwarding upstream. */
  customRequestHeaders?: Record<string, string>;
  /** Custom response headers added before sending back to tenant. */
  customResponseHeaders?: Record<string, string>;
  /** Server-side cors-allow-* equivalents (rare; opt-in). */
  accessControlAllowOriginList?: string[];
  /** When true, strip the listed request headers before upstream. */
  removeRequestHeaders?: string[];
  /**
   * HSTS max-age in seconds. Emits `Strict-Transport-Security`.
   *
   * Traefik only attaches the header when the request arrived over TLS —
   * UNLESS `forceSTSHeader` is set, which this module deliberately never does.
   * That is what keeps the header off plain-HTTP responses, where RFC 6797
   * §7.2 requires the UA to ignore it anyway.
   *
   * 0 is meaningful and must be emitted: it tells the UA to forget the host.
   */
  stsSeconds?: number;
  stsIncludeSubdomains?: boolean;
  stsPreload?: boolean;
}
export function headersSpec(args: HeadersArgs): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  if (args.customRequestHeaders) spec.customRequestHeaders = args.customRequestHeaders;
  if (args.customResponseHeaders) spec.customResponseHeaders = args.customResponseHeaders;
  if (args.accessControlAllowOriginList) spec.accessControlAllowOriginList = args.accessControlAllowOriginList;
  // `!== undefined`, not truthiness — stsSeconds: 0 is the documented way to
  // revoke a previously-advertised policy and must survive to the CRD.
  if (args.stsSeconds !== undefined) spec.stsSeconds = args.stsSeconds;
  if (args.stsIncludeSubdomains) spec.stsIncludeSubdomains = true;
  if (args.stsPreload) spec.stsPreload = true;
  if (args.removeRequestHeaders) {
    // Traefik's headers Middleware doesn't have a remove-list field per se;
    // the closest path is to set each header to "" in customRequestHeaders.
    // Done here so callers don't need to know that quirk.
    spec.customRequestHeaders = {
      ...((spec.customRequestHeaders as Record<string, string> | undefined) ?? {}),
      ...Object.fromEntries(args.removeRequestHeaders.map((h) => [h, ''])),
    };
  }
  return { headers: spec };
}

export function stripPrefixSpec(prefixes: string[]): Record<string, unknown> {
  return {
    stripPrefix: {
      prefixes,
    },
  };
}

/**
 * Chain Middleware: composes several Middlewares into a pipeline that
 * other IngressRoutes can reference as a single name.
 */
export function chainSpec(middlewares: Array<{ name: string; namespace?: string }>): Record<string, unknown> {
  return { chain: { middlewares } };
}

export interface CorazaArgs {
  /** Include OWASP CRS v4 rule bundle. Default true. */
  owaspCrs?: boolean;
  /** Anomaly-scoring threshold (inbound). Lower = stricter. Default 10. */
  anomalyThreshold?: number;
  /** Outbound anomaly threshold. Default 5. */
  outboundAnomalyThreshold?: number;
  /** CRS rule IDs to disable (e.g. ['911100', '920420']). */
  excludedRules?: string[];
  /** Max body size buffered for inspection (bytes). Default 50 MiB. */
  bodyLimit?: number;
}

/**
 * Build a Coraza WAF plugin Middleware spec. The plugin slug `coraza`
 * is set in Traefik's Helm `experimental.plugins.coraza` block by
 * scripts/bootstrap.sh. Directives use the OWASP CRS v4 bundle that
 * ships with the Coraza plugin's wasm payload.
 *
 * For the base/platform variants ship as static YAML in
 * k8s/base/traefik/middlewares-waf.yaml. This builder is for per-route
 * customisations only (excluded rules + threshold overrides).
 */
export function corazaSpec(args: CorazaArgs = {}): Record<string, unknown> {
  const includeCrs = args.owaspCrs ?? true;
  const inboundThreshold = args.anomalyThreshold ?? 10;
  const outboundThreshold = args.outboundAnomalyThreshold ?? 5;
  const bodyLimit = args.bodyLimit ?? 52428800;
  const lines: string[] = [
    'Include @coraza.conf-recommended',
  ];
  if (includeCrs) {
    lines.push('Include @crs-setup.conf.example');
    lines.push('Include @owasp_crs/*.conf');
  }
  lines.push('SecRuleEngine On');
  lines.push('SecResponseBodyAccess Off');
  lines.push('SecRequestBodyAccess On');
  lines.push(`SecRequestBodyLimit ${bodyLimit}`);
  lines.push('SecRequestBodyNoFilesLimit 131072');
  // CRS anomaly-scoring threshold tunables — must be set BEFORE the
  // CRS rules evaluate. We include the SecAction here regardless of
  // whether the threshold differs from default so the directive block
  // is self-contained.
  lines.push(`SecAction "id:900110,phase:1,nolog,pass,t:none,setvar:tx.inbound_anomaly_score_threshold=${inboundThreshold}"`);
  lines.push(`SecAction "id:900120,phase:1,nolog,pass,t:none,setvar:tx.outbound_anomaly_score_threshold=${outboundThreshold}"`);
  for (const id of args.excludedRules ?? []) {
    // SecRuleRemoveById accepts a single id per directive. CRS rule
    // ids are 6-digit integers (e.g. 911100); reject anything else as
    // a defence against directive injection.
    if (!/^\d{3,7}$/.test(id)) continue;
    lines.push(`SecRuleRemoveById ${id}`);
  }
  return {
    plugin: {
      coraza: {
        directives: lines.join('\n'),
      },
    },
  };
}

// ─── Match-expression helpers ─────────────────────────────────────────

/**
 * Encode an identifier for safe insertion into a Traefik match
 * expression — Traefik route expressions use backticks as string
 * delimiters; embedded backticks in hostnames/paths would let an
 * attacker (or a typo in a tenant domain) break out of the literal.
 * RFC-1123 DNS labels can't contain backticks, but we still defence-
 * in-depth here.
 */
export function encodeMatchLiteral(s: string): string {
  if (s.includes('`')) {
    throw new Error(`Traefik match literal cannot contain backticks: ${s}`);
  }
  return s;
}

/**
 * Traefik v3 rule for a hostname, wildcard-aware.
 *
 * `Host()` in Traefik v3 is an EXACT match — it has no wildcard form, so a
 * literal `Host(`*.example.test`)` compiles fine and then matches nothing.
 * Wildcards must go through `HostRegexp`, which takes a Go regexp.
 *
 * The generated regexp deliberately matches exactly ONE label
 * (`[^.]+`), mirroring RFC 6125 certificate semantics: `*.example.test`
 * serves `shop.example.test` but not `a.b.example.test`. A tenant who
 * needs the deeper level registers `*.b.example.test` as its own route,
 * which then gets its own wildcard certificate.
 *
 * `(?i)` because Traefik does not lowercase the Host header before
 * matching a regexp (it does for `Host()`), and hostnames are
 * case-insensitive.
 */
export function hostMatch(hostname: string): string {
  const host = encodeMatchLiteral(normalizeHostname(hostname));
  if (!isWildcardHostname(host)) {
    return `Host(\`${host}\`)`;
  }
  const base = wildcardBase(host) as string;
  return `HostRegexp(\`(?i)^[^.]+\\.${escapeRegexpLiteral(base)}$\`)`;
}

/** Escape a hostname for embedding in a Go regexp literal. */
export function escapeRegexpLiteral(s: string): string {
  return s.replace(/[.\\+*?()|[\]{}^$]/g, '\\$&');
}

export function hostAndPathMatch(hostname: string, pathPrefix: string): string {
  return `${hostMatch(hostname)} && PathPrefix(\`${encodeMatchLiteral(pathPrefix)}\`)`;
}

/**
 * Compose the match for a route row: host, optionally narrowed by path.
 * Single place so the HTTPS reconciler, the force-HTTPS companion and the
 * protected-directory child routes cannot drift apart (they had three
 * copies of this expression, one of which interpolated the hostname
 * without the backtick guard).
 */
export function routeMatch(hostname: string, pathPrefix?: string | null): string {
  return pathPrefix && pathPrefix !== '/'
    ? hostAndPathMatch(hostname, pathPrefix)
    : hostMatch(hostname);
}

/**
 * The two hostnames a www-redirect route serves.
 *
 * `canonical` is where traffic is actually served; `alternate` is the other
 * form, which must ALSO be routed so Traefik can redirect it. Returning
 * alternate = null for `none` keeps the single-host case unchanged.
 *
 * This exists because the previous implementation computed only the canonical
 * host and matched only that: with add-www on `example.com` the router matched
 * `www.example.com` alone, so the bare apex reached Traefik and matched
 * nothing — a 404. Meanwhile the redirect middleware's regex made `www.` an
 * OPTIONAL non-capturing group, so it matched the canonical host too and
 * rewrote it to itself: an infinite redirect. Both halves of the route were
 * broken, which is exactly what "enabling www-redirect kills the route" meant.
 */
export function wwwRedirectHosts(
  hostname: string,
  wwwRedirect: 'none' | 'add-www' | 'remove-www',
): { canonical: string; alternate: string | null } {
  const host = normalizeHostname(hostname);
  // A wildcard host has no meaningful www/non-www pair — `*.example.com`
  // already covers `www.example.com`, and prefixing it produces nonsense.
  if (wwwRedirect === 'none' || isWildcardHostname(host)) {
    return { canonical: host, alternate: null };
  }
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  const www = `www.${bare}`;
  return wwwRedirect === 'add-www'
    ? { canonical: www, alternate: bare }
    : { canonical: bare, alternate: www };
}

// ─── Route priority ──────────────────────────────────────────────────
//
// Traefik evaluates the HIGHEST priority first and, left to itself,
// derives a route's priority from its rule LENGTH ("the longest rule
// wins"). Introducing wildcards breaks that default in a way that is
// not merely cosmetic — it is a hostname-hijack vector:
//
//   `HostRegexp(`(?i)^[^.]+\.example\.test$`)`   → length 39
//   `Host(`webmail.example.test`)`               → length 29
//
// The platform serves webmail / autodiscover / admin hostnames on tenant
// domains from its OWN Ingresses, which carry no explicit priority. So a
// tenant wildcard would outrank them on length alone and quietly swallow
// the tenant's webmail traffic into the tenant's own workload.
//
// Fix: wildcards are pinned to a tiny priority band (≤ WILDCARD_PRIORITY_
// CEILING) that sits below the shortest realistic exact-host rule
// (`Host(`a.io`)` is already 12). Exact-host routes keep Traefik's
// default, so their behaviour is completely unchanged by this feature.
//
// Ordering inside the wildcard band, most specific first:
//   deeper wildcard   `*.a.example.test` beats `*.example.test`
//   path-narrowed     `*.example.test` + /api beats the same host at /
//   child route       a protected directory beats its own parent
//
// Note the deliberate consequence: an exact hostname beats a wildcard
// even when the wildcard carries a longer path. Host specificity is the
// stronger signal — the tenant named that host explicitly.

/**
 * Highest priority any wildcard route may carry. Must stay below the
 * rule length of the shortest exact `Host()` rule Traefik can generate,
 * because exact rules (ours and the platform's) rely on that default.
 */
export const WILDCARD_PRIORITY_CEILING = 10;

/** Depth is capped so a pathological name can't climb out of the band. */
const MAX_WILDCARD_DEPTH = 7;

/**
 * Explicit Traefik priority for a route, or `undefined` to leave
 * Traefik's length-derived default in place (exact hostnames).
 */
export function routePriority(
  hostname: string,
  pathPrefix?: string | null,
  opts?: { readonly child?: boolean },
): number | undefined {
  const host = normalizeHostname(hostname);
  if (!isWildcardHostname(host)) return undefined;

  const parent = wildcardBase(host) as string;
  const depth = Math.min(labelCount(parent), MAX_WILDCARD_DEPTH);
  const pathBonus = pathPrefix && pathPrefix !== '/' ? 1 : 0;
  const childBonus = opts?.child ? 1 : 0;

  return Math.min(depth + pathBonus + childBonus, WILDCARD_PRIORITY_CEILING);
}

/**
 * Priority fragment for spreading into a TraefikRoute — omits the field
 * entirely for exact hosts rather than writing `priority: undefined`,
 * which would serialise into the CR as an explicit null.
 */
export function routePriorityFields(
  hostname: string,
  pathPrefix?: string | null,
  opts?: { readonly child?: boolean },
): { priority?: number } {
  const priority = routePriority(hostname, pathPrefix, opts);
  return priority === undefined ? {} : { priority };
}
