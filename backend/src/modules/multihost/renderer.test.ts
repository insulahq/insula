import { describe, it, expect } from 'vitest';
import { renderSites, siteFilename, syntheticServerName, type MultihostCapability, type SiteRoute } from './renderer.js';

const CAP: MultihostCapability = {
  server: 'apache',
  web_root: '/var/www/html',
  sites_root: '/var/www/sites',
  config_dir: '/etc/apache2/insula/sites.d',
  common_include: '/etc/apache2/insula/site-common.conf',
  listen: 8080,
  validate: ['apache2ctl', 'configtest'],
  reload: ['apache2ctl', 'graceful'],
};

const route = (over: Partial<SiteRoute> & Pick<SiteRoute, 'id'>): SiteRoute => ({
  hostname: 'example.test',
  path: '/',
  wwwRedirect: 'none',
  siteFolder: 'mysite',
  ...over,
});

describe('renderSites', () => {
  it('serves an arbitrarily-named folder for a plain hostname', () => {
    const r = renderSites(CAP, [route({ id: 'a', hostname: 'shop.example.test', siteFolder: 'customer-alpha' })]);
    expect(r.skipped).toEqual([]);
    const conf = r.files[siteFilename('a')];
    expect(conf).toContain('ServerName shop.example.test');
    expect(conf).toContain('DocumentRoot "/var/www/sites/customer-alpha"');
    expect(conf).toContain('Include /etc/apache2/insula/site-common.conf');
    expect(conf).toContain('<VirtualHost *:8080>');
    // No alias for a non-wildcard host — an empty ServerAlias line would be a
    // config error, not a cosmetic blemish.
    expect(conf).not.toContain('ServerAlias');
  });

  it('names the vhost after the wwwRedirect CANONICAL host, not route.hostname', () => {
    // The alternate-form router 308s at Traefik and never reaches the backend,
    // so the container only ever sees the canonical host. Rendering
    // route.hostname would produce a vhost nothing can match.
    const r = renderSites(CAP, [route({ id: 'a', hostname: 'example.test', wwwRedirect: 'add-www' })]);
    expect(r.files[siteFilename('a')]).toContain('ServerName www.example.test');

    const r2 = renderSites(CAP, [route({ id: 'a', hostname: 'www.example.test', wwwRedirect: 'remove-www' })]);
    expect(r2.files[siteFilename('a')]).toContain('ServerName example.test');
  });

  it('routes a wildcard to ONE folder without claiming the bare hostname', () => {
    const r = renderSites(CAP, [route({ id: 'w', hostname: '*.apps.example.test', siteFolder: 'wild-one' })]);
    const conf = r.files[siteFilename('w')];
    expect(conf).toContain(`ServerName ${syntheticServerName('w')}`);
    expect(conf).toContain('ServerAlias *.apps.example.test');
    expect(conf).toContain('DocumentRoot "/var/www/sites/wild-one"');
    // The bare hostname must remain available to a different route.
    expect(conf).not.toContain('ServerName apps.example.test');
  });

  it('skips — and reports — a non-root path instead of silently widening it', () => {
    const r = renderSites(CAP, [route({ id: 'p', path: '/blog' })]);
    expect(r.files).toEqual({});
    expect(r.skipped[0].reason).toContain("path '/'");
  });

  it('skips the SECOND route claiming a hostname rather than shadowing the first', () => {
    const r = renderSites(CAP, [
      route({ id: 'aaa', hostname: 'example.test', siteFolder: 'first' }),
      // Same canonical host reached a different way: add-www on the bare name.
      route({ id: 'bbb', hostname: 'example.test', wwwRedirect: 'none', siteFolder: 'second' }),
    ]);
    expect(Object.keys(r.files)).toEqual([siteFilename('aaa')]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].routeId).toBe('bbb');
    expect(r.skipped[0].reason).toContain('already served by route aaa');
  });

  it('refuses a hostname that could inject directives', () => {
    const r = renderSites(CAP, [route({ id: 'x', hostname: 'evil.test\n    Alias /etc /etc' })]);
    expect(r.files).toEqual({});
    expect(r.skipped[0].reason).toContain('cannot be written into web-server config');
  });

  it('refuses a folder that escapes the storage root', () => {
    const r = renderSites(CAP, [route({ id: 'x', siteFolder: '../../etc' })]);
    expect(r.files).toEqual({});
    expect(r.skipped).toHaveLength(1);
  });

  it('is byte-stable for the same input regardless of row order', () => {
    // The reconciler compares rendered output to decide whether to reload. If
    // ordering leaked into the bytes, every reconcile would look like a change
    // and would reload the tenant's web server for nothing.
    const a = route({ id: 'aaa', hostname: 'a.test', siteFolder: 'fa' });
    const b = route({ id: 'bbb', hostname: 'b.test', siteFolder: 'fb' });
    expect(renderSites(CAP, [a, b]).files).toEqual(renderSites(CAP, [b, a]).files);
  });

  it('throws for a flavour it cannot render rather than emitting nothing', () => {
    // An empty ConfigMap is indistinguishable from "this deployment has no
    // sites", so a missing renderer must be loud. (nginx used to sit here; it
    // is implemented now, so the case needs a flavour that genuinely has no
    // renderer — the assertion is about the dispatch, not about nginx.)
    expect(() => renderSites({ ...CAP, server: 'caddy' }, [route({ id: 'a' })]))
      .toThrow(/no renderer for server flavour 'caddy'/);
  });

  it('renders the nginx flavour rather than rejecting it', () => {
    const r = renderSites({ ...CAP, server: 'nginx' }, [route({ id: 'a', hostname: 'n.test', siteFolder: 'nf' })]);
    expect(r.files[siteFilename('a')]).toContain('server_name n.test;');
  });
});
