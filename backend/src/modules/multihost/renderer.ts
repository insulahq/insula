/**
 * Multi-host vhost renderer — turns `ingress_routes` rows into the web-server
 * config that makes one pod answer several hostnames, each from its own folder.
 *
 * PURE on purpose. Everything that decides what a tenant's web server is told
 * to do happens here, with no cluster and no database, so the whole surface is
 * unit-testable and the reconciler only has to deliver bytes.
 *
 * Two invariants this file owns:
 *
 *  1. **The platform renders the config; the catalog never supplies it.** A
 *     manifest declares which flavour and where the files go, and admins can
 *     add third-party catalog repositories — so a repo that could hand us vhost
 *     TEXT would be handing us arbitrary directives inside a tenant's server.
 *
 *  2. **Nothing reaches the config that has not been re-validated here.**
 *     Hostnames and folders are already checked at the API, but this is the
 *     last gate before text becomes directives, and a newline in either would
 *     be config injection rather than a bad value.
 */

import { wwwRedirectHosts } from '../ingress-routes/traefik-types.js';
import { folderProblem } from '@insula/api-contracts';

/**
 * Config flavours this renderer can emit. A capability naming anything else is
 * rejected loudly rather than rendered as nothing — see `renderSites`.
 */
export const MULTIHOST_FLAVOURS = ['apache', 'nginx'] as const;
export type MultihostFlavour = typeof MULTIHOST_FLAVOURS[number];

export function isMultihostFlavour(v: string): v is MultihostFlavour {
  return (MULTIHOST_FLAVOURS as readonly string[]).includes(v);
}

/** The `multihost` block a catalog manifest declares, verbatim. */
export interface MultihostCapability {
  readonly server: string;
  readonly web_root: string;
  readonly sites_root: string;
  readonly config_dir: string;
  readonly common_include: string;
  readonly listen: number;
  readonly validate: readonly string[];
  readonly reload: readonly string[];
  /**
   * Present only on PHP runtimes. Its presence is what makes the renderer
   * sandbox a site at all — declared by the catalog manifest, never inferred
   * from the flavour, because `nginx` covers both static-nginx (no PHP, no
   * FastCGI, nothing to sandbox) and nginx-php.
   *
   * `open_basedir_extra` lists absolute paths the image needs on top of the
   * app root. `/tmp` is always among them in practice: these images leave
   * session.save_path and upload_tmp_dir empty, so PHP falls back to the
   * system temp dir and sessions break the moment it is excluded.
   */
  readonly php?: { readonly open_basedir_extra?: readonly string[] };
}

/** The subset of an `ingress_routes` row that decides what a site looks like. */
export interface SiteRoute {
  readonly id: string;
  readonly hostname: string;
  readonly path: string;
  readonly wwwRedirect: 'none' | 'add-www' | 'remove-www';
  readonly siteFolder: string;
  /** Sandbox root. Defaults to `siteFolder` when a route predates app roots. */
  readonly appRoot?: string | null;
}

export interface RenderedSite {
  readonly routeId: string;
  /** ConfigMap key = filename inside the include directory. */
  readonly filename: string;
  readonly content: string;
  /** Hostname the container will actually match on. */
  readonly serverName: string;
  readonly serverAlias: string | null;
  readonly documentRoot: string;
  /** Absolute app root — surfaced to the operator for app config files. */
  readonly appRootPath: string;
  /** Exact open_basedir written into the vhost, or null on a static runtime. */
  readonly openBasedir: string | null;
}

export interface SkippedSite {
  readonly routeId: string;
  readonly reason: string;
}

export interface RenderResult {
  /** ConfigMap `data`, ready to apply. */
  readonly files: Record<string, string>;
  readonly sites: readonly RenderedSite[];
  /** Routes deliberately not rendered, each with an operator-readable reason. */
  readonly skipped: readonly SkippedSite[];
}

/**
 * A hostname safe to write into a config file. Deliberately stricter than the
 * platform's hostname validation: this rejects everything that is not a
 * DNS-shaped label sequence with an optional leading `*.`, so no quote,
 * whitespace, newline or directive separator can survive into the output.
 */
const SAFE_HOSTNAME = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function isWildcard(host: string): boolean {
  return host.startsWith('*.');
}

/**
 * ServerName for a wildcard site.
 *
 * Apache requires a ServerName and will not accept a wildcard as one, but the
 * obvious substitute — the wildcard's own base, `apps.example.test` for
 * `*.apps.example.test` — would silently CLAIM that bare hostname, which may
 * be a different route pointing somewhere else entirely. A name in the
 * reserved `.invalid` TLD (RFC 2606) can never be requested, so the vhost is
 * reachable only through its ServerAlias. `UseCanonicalName Off` in the shared
 * include means PHP still reports the visitor's real host, never this one.
 */
export function syntheticServerName(routeId: string): string {
  return `route-${routeId}.multihost.invalid`;
}

/** ConfigMap key for a route. `.conf` so the image's include glob matches it. */
export function siteFilename(routeId: string): string {
  return `route-${routeId}.conf`;
}

interface VhostInput {
  readonly serverName: string;
  readonly serverAlias: string | null;
  readonly documentRoot: string;
  readonly hostname: string;
  readonly routeId: string;
  /** Absolute app root, or null on a runtime with no PHP to sandbox. */
  readonly appRootPath: string | null;
  readonly cap: MultihostCapability;
}

/**
 * The value of PHP's `open_basedir` for one site: its app root plus whatever
 * absolute paths the image declared it needs.
 *
 * Returns null when the runtime declares no `php` block, so a static image
 * gets a plain vhost with no FastCGI directives it could not honour anyway.
 */
export function openBasedirFor(cap: MultihostCapability, appRootPath: string | null): string | null {
  if (!cap.php || !appRootPath) return null;
  return [appRootPath, ...(cap.php.open_basedir_extra ?? [])].join(':');
}

const BANNER = (routeId: string, hostname: string): string[] => [
  `# Route ${routeId} — ${hostname}`,
  '# Generated by the Insula platform. Edits here are overwritten on the next',
  '# route change; the folder a hostname serves is a property of the route.',
];

function renderApacheVhost(cap: MultihostCapability, site: VhostInput): string {
  const alias = site.serverAlias ? [`    ServerAlias ${site.serverAlias}`] : [];
  const basedir = openBasedirFor(cap, site.appRootPath);
  // mod_proxy_fcgi forwards subprocess_env to the pool, and PHP-FPM applies
  // PHP_ADMIN_VALUE — so a per-vhost SetEnv sandboxes this site's PHP without
  // a second FPM pool. Verified against the shipped image, not assumed.
  //
  // ONE setting only: Apache config has no way to embed the newline that
  // PHP-FPM uses to separate several. `disable_functions` therefore rides on
  // the FPM pool instead (pool-scoped, so CLI keeps exec for cron/composer) —
  // and it MUST, because open_basedir does not restrain a child process:
  // shell_exec walks straight past it.
  const sandbox = basedir ? [`    SetEnv PHP_ADMIN_VALUE "open_basedir=${basedir}"`] : [];
  return [
    ...BANNER(site.routeId, site.hostname),
    `<VirtualHost *:${cap.listen}>`,
    `    ServerName ${site.serverName}`,
    ...alias,
    `    DocumentRoot "${site.documentRoot}"`,
    ...sandbox,
    `    Include ${cap.common_include}`,
    '</VirtualHost>',
    '',
  ].join('\n');
}

/**
 * nginx server block.
 *
 * Two differences from Apache, both load-bearing:
 *
 *  - nginx accepts a wildcard directly in `server_name`, so there is no
 *    synthetic name and no ServerAlias — `*.apps.example.test` is the name.
 *  - NO `listen` directive. The image owns its own sockets: the stock server
 *    already binds both families (and serversideup honours
 *    NGINX_LISTEN_IP_PROTOCOL when an operator restricts them), and nginx
 *    matches `server_name` only among blocks listening on the SAME address —
 *    so a hard-coded IPv4-only listen here would make every site unreachable
 *    over IPv6 while the catch-all still answered. The image's
 *    `common_include` carries the listen lines.
 */
function renderNginxServer(cap: MultihostCapability, site: VhostInput): string {
  const basedir = openBasedirFor(cap, site.appRootPath);
  // Set as a VARIABLE, not a fastcgi_param, and deliberately so: nginx only
  // inherits fastcgi_param from an outer level when the inner level declares
  // none, and the shared include's PHP location declares several — a
  // server-level fastcgi_param here would be silently ignored. The include
  // reads `$insula_php_admin`, so one shared file still serves every site.
  //
  // Always emitted when the runtime has PHP: an unset variable is a startup
  // error in nginx, which would take down every site in the pod, not just
  // this one.
  const sandbox = basedir ? [`    set $insula_php_admin "open_basedir=${basedir}";`] : [];
  return [
    ...BANNER(site.routeId, site.hostname),
    'server {',
    `    server_name ${site.serverName};`,
    `    root "${site.documentRoot}";`,
    ...sandbox,
    `    include ${cap.common_include};`,
    '}',
    '',
  ].join('\n');
}

/**
 * One renderer per flavour, as a Record so TypeScript refuses a new flavour
 * that nobody implemented. A `switch` with a default, or an if/else chain,
 * would let a flavour slip through and emit nothing — which is
 * indistinguishable from "this deployment has no sites".
 */
const RENDERERS: Record<MultihostFlavour, (cap: MultihostCapability, site: VhostInput) => string> = {
  apache: renderApacheVhost,
  nginx: renderNginxServer,
};

/**
 * Render every route that names a folder into one config file each.
 *
 * A route is SKIPPED rather than rendered when it cannot be expressed safely.
 * Skipping is reported, never silent: a site that does not appear in the
 * output falls through to the deployment's stock document root, which looks
 * exactly like a working catch-all and would otherwise hide the mistake.
 */
export function renderSites(
  cap: MultihostCapability,
  routes: readonly SiteRoute[],
): RenderResult {
  if (!isMultihostFlavour(cap.server)) {
    // Loud on purpose. A capability naming a flavour with no renderer must fail
    // here rather than emit an empty ConfigMap, which would read as "this
    // deployment has no sites".
    throw new Error(
      `multihost: no renderer for server flavour '${cap.server}' ` +
      `(supported: ${MULTIHOST_FLAVOURS.join(', ')})`,
    );
  }
  const renderVhost = RENDERERS[cap.server];

  const files: Record<string, string> = {};
  const sites: RenderedSite[] = [];
  const skipped: SkippedSite[] = [];
  // Matchers already claimed, so a second route cannot quietly shadow a first.
  const claimed = new Map<string, string>();

  // Deterministic order: the ConfigMap must be byte-identical for identical
  // input or every reconcile looks like a change and reloads the server.
  const ordered = [...routes].sort((a, b) => a.id.localeCompare(b.id));

  for (const route of ordered) {
    const { canonical } = wwwRedirectHosts(route.hostname, route.wwwRedirect);

    if (route.path !== '/') {
      // A vhost is keyed by hostname; there is no path in the matcher. Serving
      // a folder for `example.com/blog` would silently serve it for the whole
      // of example.com. Refuse instead of surprising the tenant.
      skipped.push({
        routeId: route.id,
        reason: `Route path is '${route.path}'. A site folder applies to a whole hostname, so it can only be set on a route with path '/'.`,
      });
      continue;
    }

    if (!SAFE_HOSTNAME.test(canonical)) {
      skipped.push({
        routeId: route.id,
        reason: `Hostname '${canonical}' is not a plain DNS name and cannot be written into web-server config.`,
      });
      continue;
    }

    const folderIssue = folderProblem(route.siteFolder);
    if (folderIssue) {
      skipped.push({ routeId: route.id, reason: folderIssue });
      continue;
    }

    // The app root is re-validated here for the same reason the folder is:
    // this is the last gate before a value becomes a directive, and this one
    // becomes the sandbox itself. It reaches the config through
    // `SetEnv PHP_ADMIN_VALUE "open_basedir=…"` and through the pod's mount
    // list, so a colon or a newline in it would not be a bad value — it would
    // be an extra directive, or an extra path inside open_basedir.
    //
    // Today every write path runs the identical check at the API boundary, and
    // there is no DB constraint on the column's FORMAT (0105 constrains only
    // the pairing). "Validated upstream" is a property of today's callers, not
    // of the column — and this file's whole contract is that nothing reaches
    // the config unchecked.
    if (route.appRoot != null) {
      const appRootIssue = folderProblem(route.appRoot);
      if (appRootIssue) {
        skipped.push({ routeId: route.id, reason: `application root: ${appRootIssue}` });
        continue;
      }
    }

    const previous = claimed.get(canonical);
    if (previous) {
      skipped.push({
        routeId: route.id,
        reason: `Hostname '${canonical}' is already served by route ${previous} on this deployment. Two routes cannot serve the same hostname from different folders.`,
      });
      continue;
    }
    claimed.set(canonical, route.id);

    // Apache cannot take a wildcard as ServerName, so a wildcard site is named
    // synthetically and matched through ServerAlias. nginx accepts the wildcard
    // as the name itself, so it needs neither.
    const wildcard = isWildcard(canonical);
    const usesAlias = cap.server === 'apache' && wildcard;
    const serverName = usesAlias ? syntheticServerName(route.id) : canonical;
    const serverAlias = usesAlias ? canonical : null;
    const documentRoot = `${cap.sites_root}/${route.siteFolder}`;
    // A route created before app roots existed, or one whose app root was
    // never set, sandboxes to the folder it serves. That is the tighter of the
    // two readings and it cannot break a site: the document root is always
    // inside its own sandbox.
    const appRootPath = `${cap.sites_root}/${route.appRoot ?? route.siteFolder}`;

    const filename = siteFilename(route.id);
    files[filename] = renderVhost(cap, {
      serverName,
      serverAlias,
      documentRoot,
      hostname: route.hostname,
      routeId: route.id,
      appRootPath,
      cap,
    });
    sites.push({
      routeId: route.id,
      filename,
      content: files[filename],
      serverName,
      serverAlias,
      documentRoot,
      appRootPath,
      openBasedir: openBasedirFor(cap, appRootPath),
    });
  }

  return { files, sites, skipped };
}
