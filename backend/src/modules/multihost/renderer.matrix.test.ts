import { describe, it, expect } from 'vitest';
import {
  renderSites, siteFilename, syntheticServerName, MULTIHOST_FLAVOURS,
  type MultihostCapability, type SiteRoute, type MultihostFlavour,
} from './renderer.js';
import { folderProblem } from '@insula/api-contracts';

const CAPS: Record<MultihostFlavour, MultihostCapability> = {
  apache: {
    server: 'apache', web_root: '/var/www/html', sites_root: '/var/www/sites',
    config_dir: '/etc/apache2/insula/sites.d', common_include: '/etc/apache2/insula/site-common.conf',
    listen: 8080, validate: ['apache2ctl', 'configtest'], reload: ['apache2ctl', 'graceful'],
  },
  nginx: {
    server: 'nginx', web_root: '/var/www/html', sites_root: '/var/www/sites',
    config_dir: '/etc/nginx/insula/sites.d', common_include: '/etc/nginx/insula/site-common.conf',
    listen: 8080, validate: ['nginx', '-t'], reload: ['nginx', '-s', 'reload'],
  },
};

const route = (over: Partial<SiteRoute> & Pick<SiteRoute, 'id'>): SiteRoute => ({
  hostname: 'example.test', path: '/', wwwRedirect: 'none', siteFolder: 'mysite', ...over,
});

describe.each(MULTIHOST_FLAVOURS)('renderSites — %s flavour', (flavour) => {
  const CAP = CAPS[flavour];
  const only = (r: SiteRoute[]) => renderSites(CAP, r);

  it('emits exactly one file per accepted route, keyed by route id', () => {
    const r = only([route({ id: 'a', hostname: 'a.test', siteFolder: 'fa' }),
                    route({ id: 'b', hostname: 'b.test', siteFolder: 'fb' })]);
    expect(Object.keys(r.files).sort()).toEqual([siteFilename('a'), siteFilename('b')]);
    expect(r.skipped).toEqual([]);
  });

  it('points the document root at the folder under sites_root', () => {
    const conf = only([route({ id: 'a', siteFolder: 'deep/nested/folder' })]).files[siteFilename('a')];
    expect(conf).toContain('/var/www/sites/deep/nested/folder');
  });

  it('includes the image-owned common file', () => {
    const conf = only([route({ id: 'a' })]).files[siteFilename('a')];
    expect(conf).toContain(CAP.common_include);
  });

  it.each([
    ['none' as const,        'example.test',     'example.test'],
    ['add-www' as const,     'example.test',     'www.example.test'],
    ['remove-www' as const,  'www.example.test', 'example.test'],
    ['add-www' as const,     'www.example.test', 'www.example.test'],
    ['remove-www' as const,  'example.test',     'example.test'],
  ])('wwwRedirect=%s on %s serves the canonical name %s', (wwwRedirect, hostname, canonical) => {
    const conf = only([route({ id: 'a', hostname, wwwRedirect })]).files[siteFilename('a')];
    // The alternate form 308s at Traefik and never reaches the backend, so the
    // container must be configured for the canonical name only.
    const directive = flavour === 'apache' ? `ServerName ${canonical}` : `server_name ${canonical};`;
    expect(conf).toContain(directive);
  });

  it('serves a wildcard from ONE folder without claiming the bare hostname', () => {
    const conf = only([route({ id: 'w', hostname: '*.apps.example.test', siteFolder: 'wild' })]).files[siteFilename('w')];
    expect(conf).toContain('/var/www/sites/wild');
    if (flavour === 'apache') {
      // Apache refuses a wildcard ServerName, so it is matched via ServerAlias
      // behind a name in the reserved .invalid TLD.
      expect(conf).toContain(`ServerName ${syntheticServerName('w')}`);
      expect(conf).toContain('ServerAlias *.apps.example.test');
    } else {
      // nginx takes the wildcard as the name itself.
      expect(conf).toContain('server_name *.apps.example.test;');
      expect(conf).not.toContain('.invalid');
    }
    const bare = flavour === 'apache' ? 'ServerName apps.example.test' : 'server_name apps.example.test;';
    expect(conf).not.toContain(bare);
  });

  it('wildcard + wwwRedirect does not mangle the name', () => {
    // wwwRedirectHosts is a no-op for wildcards; prefixing www. to `*.x` would
    // produce nonsense that matches nothing.
    for (const w of ['add-www', 'remove-www', 'none'] as const) {
      const conf = only([route({ id: 'w', hostname: '*.apps.example.test', wwwRedirect: w })]).files[siteFilename('w')];
      expect(conf).toContain('*.apps.example.test');
      expect(conf).not.toContain('www.*');
      expect(conf).not.toContain('*.www.');
    }
  });

  it('skips a non-root path rather than widening the folder to the host', () => {
    for (const p of ['/blog', '/a/b', '/x/']) {
      const r = only([route({ id: 'p', path: p })]);
      expect(r.files).toEqual({});
      expect(r.skipped[0].reason).toContain("path '/'");
    }
  });

  it('keeps the first claimant of a hostname and reports the second', () => {
    const r = only([
      route({ id: 'aaa', hostname: 'dup.test', siteFolder: 'first' }),
      route({ id: 'bbb', hostname: 'dup.test', siteFolder: 'second' }),
    ]);
    expect(Object.keys(r.files)).toEqual([siteFilename('aaa')]);
    expect(r.skipped[0].reason).toContain('already served by route aaa');
  });

  it('detects a collision produced by wwwRedirect, not just identical hostnames', () => {
    // `example.test` with add-www and `www.example.test` with none both resolve
    // to the same canonical name. Rendering both would let Apache/nginx pick.
    const r = only([
      route({ id: 'aaa', hostname: 'example.test', wwwRedirect: 'add-www', siteFolder: 'one' }),
      route({ id: 'bbb', hostname: 'www.example.test', wwwRedirect: 'none', siteFolder: 'two' }),
    ]);
    expect(Object.keys(r.files)).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  });

  it('is byte-stable regardless of input order', () => {
    const a = route({ id: 'aaa', hostname: 'a.test', siteFolder: 'fa' });
    const b = route({ id: 'bbb', hostname: 'b.test', siteFolder: 'fb' });
    const c = route({ id: 'ccc', hostname: '*.c.test', siteFolder: 'fc' });
    expect(only([a, b, c]).files).toEqual(only([c, a, b]).files);
    expect(only([a, b, c]).files).toEqual(only([b, c, a]).files);
  });

  it('renders many sites without dropping any', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      route({ id: `r${String(i).padStart(3, '0')}`, hostname: `s${i}.test`, siteFolder: `folder-${i}` }));
    const r = only(many);
    expect(Object.keys(r.files)).toHaveLength(250);
    expect(r.skipped).toEqual([]);
  });
});

describe('flavour dispatch', () => {
  it('throws for a flavour with no renderer, naming what is supported', () => {
    expect(() => renderSites({ ...CAPS.apache, server: 'caddy' }, [route({ id: 'a' })]))
      .toThrow(/no renderer for server flavour 'caddy'.*apache, nginx/);
  });
  it('throws before emitting anything, so an unknown flavour is never "no sites"', () => {
    expect(() => renderSites({ ...CAPS.apache, server: '' }, [])).toThrow();
  });
});
