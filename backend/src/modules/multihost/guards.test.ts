import { describe, it, expect } from 'vitest';
import { assertSiteFolderAllowed } from '../ingress-routes/service.js';

const CAP = {
  server: 'apache', web_root: '/var/www/html', sites_root: '/var/www/sites',
  config_dir: '/etc/apache2/insula/sites.d', common_include: '/etc/apache2/insula/site-common.conf',
  listen: 8080, validate: ['apache2ctl', 'configtest'], reload: ['apache2ctl', 'graceful'],
};
const capableEntry = { multihost: CAP };
const onDep = { name: 'sites', multihostEnabled: true };

describe('assertSiteFolderAllowed', () => {
  it('allows a folder on a multi-host deployment at the route root', () => {
    expect(() => assertSiteFolderAllowed('mysite', onDep, capableEntry, '/')).not.toThrow();
  });

  it('allows clearing the folder regardless of capability or flag', () => {
    // Clearing hands the hostname back to the stock docroot, which is always
    // legal — refusing it would strand a route on a deployment that has since
    // lost the capability.
    expect(() => assertSiteFolderAllowed(null, { name: 'x', multihostEnabled: false }, null, '/blog')).not.toThrow();
  });

  it('refuses when the catalog entry declares no capability', () => {
    expect(() => assertSiteFolderAllowed('mysite', onDep, { multihost: null }, '/'))
      .toThrow(/cannot serve several sites/);
  });

  it('refuses when the operator has not enabled multi-host', () => {
    expect(() => assertSiteFolderAllowed('mysite', { name: 'sites', multihostEnabled: false }, capableEntry, '/'))
      .toThrow(/Turn on multi-host serving/);
  });

  it('refuses a non-root path, which would widen the folder to the whole hostname', () => {
    expect(() => assertSiteFolderAllowed('mysite', onDep, capableEntry, '/blog'))
      .toThrow(/whole hostname/);
  });
});
