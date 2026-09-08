import { describe, it, expect } from 'vitest';
import { renderSites, openBasedirFor, type MultihostCapability, type SiteRoute } from './renderer.js';

const APACHE: MultihostCapability = {
  server: 'apache',
  web_root: '/var/www/html',
  sites_root: '/var/www/sites',
  config_dir: '/etc/apache2/insula/sites.d',
  common_include: '/etc/apache2/insula/site-common.conf',
  listen: 8080,
  validate: ['apache2ctl', 'configtest'],
  reload: ['apache2ctl', 'graceful'],
  php: { open_basedir_extra: ['/tmp'] },
};
const NGINX: MultihostCapability = { ...APACHE, server: 'nginx', php: { open_basedir_extra: ['/tmp'] } };
/** static-nginx: same flavour, no PHP — nothing to sandbox. */
const STATIC: MultihostCapability = { ...NGINX, php: undefined };

const route = (over: Partial<SiteRoute> = {}): SiteRoute => ({
  id: 'r1',
  hostname: 'site.example.test',
  path: '/',
  wwwRedirect: 'none',
  siteFolder: 'mysite',
  ...over,
});

describe('open_basedir value', () => {
  it('is the app root plus the paths the image declared it needs', () => {
    expect(openBasedirFor(APACHE, '/var/www/sites/app', '/var/www/sites/.insula-sessions/app'))
      .toBe('/var/www/sites/app:/var/www/sites/.insula-sessions/app:/tmp');
  });

  it('is null on a runtime that declares no PHP', () => {
    expect(openBasedirFor(STATIC, '/var/www/sites/app', null)).toBeNull();
  });

  it('includes /tmp — PHP falls back there for sessions and uploads', () => {
    // Measured on the shipped image: session.save_path and upload_tmp_dir are
    // both empty, so excluding /tmp breaks every session-using site.
    expect(openBasedirFor(NGINX, '/var/www/sites/app', null)).toContain(':/tmp');
  });
});

describe('apache sandboxes each vhost', () => {
  it('sets open_basedir to the app root', () => {
    const { files } = renderSites(APACHE, [route({ siteFolder: 'shop/public', appRoot: 'shop' })]);
    const vhost = Object.values(files)[0];
    expect(vhost).toContain('DocumentRoot "/var/www/sites/shop/public"');
    expect(vhost).toContain('open_basedir=/var/www/sites/shop:/var/www/sites/.insula-sessions/shop:/tmp');
  });

  it('falls back to the served folder when no app root is recorded', () => {
    const { files } = renderSites(APACHE, [route({ siteFolder: 'plain', appRoot: null })]);
    expect(Object.values(files)[0]).toContain('open_basedir=/var/www/sites/plain:/var/www/sites/.insula-sessions/plain:/tmp');
  });

  it('never sandboxes a runtime with no PHP', () => {
    const { files } = renderSites(STATIC, [route()]);
    expect(Object.values(files)[0]).not.toContain('PHP_ADMIN_VALUE');
  });
});

describe('nginx sandboxes each server block', () => {
  it('sets the variable the shared include reads', () => {
    const { files } = renderSites(NGINX, [route({ siteFolder: 'shop/public', appRoot: 'shop' })]);
    const conf = Object.values(files)[0];
    expect(conf).toContain('root "/var/www/sites/shop/public"');
    expect(conf).toContain('set $insula_php_admin "open_basedir=/var/www/sites/shop:/var/www/sites/.insula-sessions/shop:/tmp');
    expect(conf).toContain('session.save_path=/var/www/sites/.insula-sessions/shop";');
  });

  /**
   * The pod-down case. nginx treats an unset variable as a STARTUP error, and
   * the shared include references $insula_php_admin unconditionally — so a
   * single generated block missing its `set` takes down every site in the pod,
   * not just its own.
   */
  it('emits the variable for EVERY rendered site, without exception', () => {
    const routes = [
      route({ id: 'a', hostname: 'a.example.test', siteFolder: 'a' }),
      route({ id: 'b', hostname: 'b.example.test', siteFolder: 'b/public', appRoot: 'b' }),
      route({ id: 'c', hostname: '*.c.example.test', siteFolder: 'c', appRoot: null }),
    ];
    const { files, sites } = renderSites(NGINX, routes);
    expect(sites).toHaveLength(3);
    for (const [name, conf] of Object.entries(files)) {
      expect(conf, `${name} has no sandbox variable`).toContain('set $insula_php_admin ');
    }
  });

  it('omits it on static-nginx, whose include never reads it', () => {
    const { files } = renderSites(STATIC, [route()]);
    expect(Object.values(files)[0]).not.toContain('insula_php_admin');
  });
});

describe('rendered sites report their absolute paths', () => {
  it('surfaces app root and the exact open_basedir for the operator', () => {
    const { sites } = renderSites(APACHE, [route({ siteFolder: 'shop/public', appRoot: 'shop' })]);
    expect(sites[0].documentRoot).toBe('/var/www/sites/shop/public');
    expect(sites[0].appRootPath).toBe('/var/www/sites/shop');
    expect(sites[0].openBasedir).toBe('/var/www/sites/shop:/var/www/sites/.insula-sessions/shop:/tmp');
    expect(sites[0].sessionPath).toBe('/var/www/sites/.insula-sessions/shop');
  });
});

// ─── Catalog-supplied sandbox declarations are not trusted ──────────────────
import { phpSandboxIsSane } from './reconciler.js';

describe('a catalog repository cannot dissolve the sandbox', () => {
  const SITES = '/var/www/sites';

  it('accepts the ordinary declaration', () => {
    expect(phpSandboxIsSane({ open_basedir_extra: ['/tmp'] }, SITES)).toBe(true);
    expect(phpSandboxIsSane(undefined, SITES)).toBe(true);
    expect(phpSandboxIsSane({}, SITES)).toBe(true);
  });

  it('refuses root, which would sandbox nothing', () => {
    expect(phpSandboxIsSane({ open_basedir_extra: ['/'] }, SITES)).toBe(false);
  });

  it('refuses an ancestor of the sites root — every site readable again', () => {
    expect(phpSandboxIsSane({ open_basedir_extra: ['/var/www/sites'] }, SITES)).toBe(false);
    expect(phpSandboxIsSane({ open_basedir_extra: ['/var/www'] }, SITES)).toBe(false);
    expect(phpSandboxIsSane({ open_basedir_extra: ['/var/www/'] }, SITES)).toBe(false);
  });

  it('refuses separator and newline injection into the directive', () => {
    expect(phpSandboxIsSane({ open_basedir_extra: ['/tmp:/var/www/sites'] }, SITES)).toBe(false);
    expect(phpSandboxIsSane({ open_basedir_extra: ['/tmp\ndisable_functions='] }, SITES)).toBe(false);
  });

  it('refuses malformed shapes rather than ignoring them', () => {
    expect(phpSandboxIsSane({ open_basedir_extra: 'tmp' }, SITES)).toBe(false);
    expect(phpSandboxIsSane({ open_basedir_extra: [42] }, SITES)).toBe(false);
    expect(phpSandboxIsSane({ open_basedir_extra: ['relative/path'] }, SITES)).toBe(false);
    expect(phpSandboxIsSane('php', SITES)).toBe(false);
  });
});

describe('the renderer re-validates the app root, not just the folder', () => {
  const hostile = (appRoot: string) => renderSites(APACHE, [route({ siteFolder: 'ok', appRoot })]);

  it('refuses a colon, which would append a path to open_basedir', () => {
    const { files, skipped } = hostile('ok:/var/www/sites');
    expect(Object.keys(files)).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/application root/);
  });

  it('refuses a newline, which would end the directive', () => {
    expect(Object.keys(hostile('ok\nSetEnv X Y').files)).toHaveLength(0);
  });

  it('refuses traversal', () => {
    expect(Object.keys(hostile('../../etc').files)).toHaveLength(0);
  });

  it('still renders a legitimate parent app root', () => {
    const { files, skipped } = renderSites(APACHE, [route({ siteFolder: 'shop/public', appRoot: 'shop' })]);
    expect(skipped).toHaveLength(0);
    expect(Object.values(files)[0]).toContain('open_basedir=/var/www/sites/shop:');
  });
});

/**
 * Sessions must not live in /tmp.
 *
 * /tmp is shared by every site in the pod and MUST stay inside open_basedir
 * for sessions to work at all — and a session filename IS the session ID. So
 * a site could list /tmp, read a neighbour's session file and replay that ID
 * as its own cookie: takeover of a sibling site with no exec and no sandbox
 * bypass. Each app root gets its own directory instead, inside the sandbox
 * that already confines it.
 */
describe('session files are per-site, not shared through /tmp', () => {
  it('apache points PHP at the app root, via the second variable', () => {
    const { files } = renderSites(APACHE, [route({ siteFolder: 'shop/public', appRoot: 'shop' })]);
    const vhost = Object.values(files)[0];
    expect(vhost).toContain('SetEnv PHP_VALUE "session.save_path=/var/www/sites/.insula-sessions/shop"');
    // open_basedir must stay in PHP_ADMIN_VALUE, where a script cannot widen it.
    expect(vhost).toContain('SetEnv PHP_ADMIN_VALUE "open_basedir=');
  });

  it('the session dir is NOT under the app root, so it can never be served', () => {
    const { sites } = renderSites(APACHE, [route({ siteFolder: 'shop', appRoot: 'shop' })]);
    // Under the document root it would be fetchable as /.insula-sessions/sess_<id>
    // whenever docroot == app root, which is the common case.
    expect(sites[0].sessionPath?.startsWith(`${sites[0].appRootPath}/`)).toBe(false);
  });

  it('but IS named in open_basedir, or every session write would be denied', () => {
    const { sites } = renderSites(APACHE, [route({ siteFolder: 'shop', appRoot: 'shop' })]);
    expect(sites[0].openBasedir?.split(':')).toContain(sites[0].sessionPath);
  });

  it('two sites get two different session directories', () => {
    const { files } = renderSites(APACHE, [
      route({ id: 'a', hostname: 'a.example.test', siteFolder: 'a' }),
      route({ id: 'b', hostname: 'b.example.test', siteFolder: 'b' }),
    ]);
    const all = Object.values(files).join('\n');
    expect(all).toContain('/var/www/sites/.insula-sessions/a');
    expect(all).toContain('/var/www/sites/.insula-sessions/b');
  });

  it('two hostnames sharing one app root share one session dir, so logins survive www redirects', () => {
    const { files } = renderSites(APACHE, [
      route({ id: 'a', hostname: 'ex.example.test', siteFolder: 'shop/public', appRoot: 'shop' }),
      route({ id: 'b', hostname: 'www.ex.example.test', siteFolder: 'shop/public', appRoot: 'shop' }),
    ]);
    for (const conf of Object.values(files)) {
      expect(conf).toContain('session.save_path=/var/www/sites/.insula-sessions/shop');
    }
  });

  it('a static runtime gets no session directive — it has no PHP', () => {
    const { files } = renderSites(STATIC, [route()]);
    expect(Object.values(files)[0]).not.toContain('session.save_path');
  });
});

import { absolutePathIsSane } from './reconciler.js';

describe('sites_root from a catalog manifest is validated too', () => {
  it('accepts an ordinary site tree', () => {
    expect(absolutePathIsSane('/var/www/sites')).toBe(true);
  });

  it('refuses system directories a site must never be handed', () => {
    for (const p of ['/etc', '/etc/ssl', '/proc', '/root', '/usr/bin', '/']) {
      expect(absolutePathIsSane(p), p).toBe(false);
    }
  });

  it('refuses traversal and injection', () => {
    for (const p of ['/var/www/../etc', '/var/www/./x', '/var/www:/etc', '/var/www\nX', '/var/www"x']) {
      expect(absolutePathIsSane(p), p).toBe(false);
    }
  });

  it('refuses a relative path or a non-string', () => {
    expect(absolutePathIsSane('var/www')).toBe(false);
    expect(absolutePathIsSane(42)).toBe(false);
  });
});

describe('per-site Options are scoped to multi-host sites only', () => {
  it('apache scopes Options to this site document root', () => {
    const { files } = renderSites(APACHE, [route({ siteFolder: 'shop/public', appRoot: 'shop' })]);
    const vhost = Object.values(files)[0];
    expect(vhost).toContain('<Directory "/var/www/sites/shop/public">');
    expect(vhost).toContain('Options -Indexes');
  });

  /**
   * `-FollowSymLinks` is what would close the symlink escape, and it CANNOT be
   * used: Apache refuses RewriteRule when FollowSymLinks and
   * SymLinksIfOwnerMatch are both off (AH00670). The shared include rewrites,
   * and so does every WordPress .htaccess — turning it off returned 403 on
   * every request to every multi-host site. Found by E2E against a real pod;
   * no unit test on the rendered text could have found it.
   */
  it('does NOT disable symlink following, which would 403 every site', () => {
    const { files } = renderSites(APACHE, [route({ siteFolder: 'shop' })]);
    expect(Object.values(files)[0]).not.toContain('-FollowSymLinks');
  });

  /**
   * It must live in the GENERATED vhost, not the shared include: that include
   * also governs the stock single-site vhost, which mounts only its own folder
   * — banning symlinks there breaks Laravel's public/storage for no gain.
   */
  it('the confinement names the site docroot, so it cannot leak to the stock vhost', () => {
    const { files } = renderSites(APACHE, [route({ siteFolder: 'only-me' })]);
    const vhost = Object.values(files)[0];
    expect(vhost).toContain('<Directory "/var/www/sites/only-me">');
    expect(vhost).not.toContain('<Directory "/var/www">');
  });

  it('a static apache runtime is scoped the same way', () => {
    const STATIC_AP: typeof APACHE = { ...APACHE, php: undefined };
    expect(Object.values(renderSites(STATIC_AP, [route()]).files)[0]).toContain('Options -Indexes');
  });
});

import { buildMultihostMounts } from '../deployments/k8s-deployer.js';

/**
 * The deployer and the reconciler both decide what a multi-host pod mounts —
 * one when the template is built, the other on every route change. If they
 * disagree, the pod silently loses whichever mounts the second one forgets.
 * Observed on DEV: session mounts present after a deploy, gone after the next
 * route change, leaving session.save_path pointing at nothing.
 */
describe('the deployer and the reconciler agree on the mount set', () => {
  it('both emit a site mount AND a session mount per folder', () => {
    const { mounts } = buildMultihostMounts(
      { configDir: '/c', sitesRoot: '/var/www/sites', configMapName: 'cm', siteFolders: ['shop'] },
      'tenant-x',
    );
    const paths = mounts.map((m) => `${m.mountPath}|${m.subPath ?? ''}`);
    expect(paths).toContain('/var/www/sites/shop|shop');
    expect(paths).toContain('/var/www/sites/.insula-sessions/shop|.insula-sessions/shop');
  });

  it('a session mount is never nested inside a served folder', () => {
    const { mounts } = buildMultihostMounts(
      { configDir: '/c', sitesRoot: '/var/www/sites', configMapName: 'cm', siteFolders: ['shop', 'blog'] },
      'tenant-x',
    );
    const sessions = mounts.filter((m) => String(m.subPath ?? '').startsWith('.insula-sessions'));
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      for (const folder of ['shop', 'blog']) {
        expect(String(s.mountPath).startsWith(`/var/www/sites/${folder}/`)).toBe(false);
      }
    }
  });
});
