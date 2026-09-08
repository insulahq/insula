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
    expect(openBasedirFor(APACHE, '/var/www/sites/app')).toBe('/var/www/sites/app:/tmp');
  });

  it('is null on a runtime that declares no PHP', () => {
    expect(openBasedirFor(STATIC, '/var/www/sites/app')).toBeNull();
  });

  it('includes /tmp — PHP falls back there for sessions and uploads', () => {
    // Measured on the shipped image: session.save_path and upload_tmp_dir are
    // both empty, so excluding /tmp breaks every session-using site.
    expect(openBasedirFor(NGINX, '/var/www/sites/app')).toContain(':/tmp');
  });
});

describe('apache sandboxes each vhost', () => {
  it('sets open_basedir to the app root', () => {
    const { files } = renderSites(APACHE, [route({ siteFolder: 'shop/public', appRoot: 'shop' })]);
    const vhost = Object.values(files)[0];
    expect(vhost).toContain('DocumentRoot "/var/www/sites/shop/public"');
    expect(vhost).toContain('SetEnv PHP_ADMIN_VALUE "open_basedir=/var/www/sites/shop:/tmp"');
  });

  it('falls back to the served folder when no app root is recorded', () => {
    const { files } = renderSites(APACHE, [route({ siteFolder: 'plain', appRoot: null })]);
    expect(Object.values(files)[0]).toContain('open_basedir=/var/www/sites/plain:/tmp');
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
    expect(conf).toContain('set $insula_php_admin "open_basedir=/var/www/sites/shop:/tmp";');
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
    expect(sites[0].openBasedir).toBe('/var/www/sites/shop:/tmp');
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
