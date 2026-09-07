import { describe, it, expect } from 'vitest';
import { resolveTenantVolumePath, computeVolumePaths } from './service.js';

describe('resolveTenantVolumePath', () => {
  it('renders the storage root absolute when local_path is "."', () => {
    // The Official apache-php entry declares `local_path: "."`. The panel used
    // to render that marker literally, so the column showed a bare ".".
    expect(resolveTenantVolumePath('runtime/apache-php/contentbase', '.')).toBe('/runtime/apache-php/contentbase');
  });

  it('always leads with a slash — storage_path is stored without one', () => {
    // Stored as `static/nginx/example`, which reads as a relative path and
    // cannot be pasted into the file manager or an SFTP client.
    expect(resolveTenantVolumePath('static/nginx/example', '.')).toBe('/static/nginx/example');
  });

  it('appends a non-"." local_path under the root', () => {
    expect(resolveTenantVolumePath('runtime/apache-php/site', 'public')).toBe('/runtime/apache-php/site/public');
  });

  it('collapses redundant separators and dot segments', () => {
    expect(resolveTenantVolumePath('/static//nginx/', './sub/')).toBe('/static/nginx/sub');
  });

  it('degrades to "/" rather than an empty string', () => {
    expect(resolveTenantVolumePath('', '.')).toBe('/');
    expect(resolveTenantVolumePath('', undefined)).toBe('/');
  });
});

describe('computeVolumePaths', () => {
  it('resolves each volume against the deployment storage root', () => {
    const paths = computeVolumePaths(
      { storagePath: 'runtime/apache-php/contentbase' },
      { volumes: JSON.stringify([
        { container_path: '/var/www/html', local_path: '.' },
        { container_path: '/var/www/data', local_path: 'data' },
      ]) },
    );
    expect(paths).toEqual([
      { containerPath: '/var/www/html', k8sPath: '/runtime/apache-php/contentbase' },
      { containerPath: '/var/www/data', k8sPath: '/runtime/apache-php/contentbase/data' },
    ]);
  });

  it('no longer gives every volume the same bare base path', () => {
    // The old implementation ignored local_path entirely, so two volumes on one
    // deployment displayed as the same directory.
    const paths = computeVolumePaths(
      { storagePath: 'runtime/x/y' },
      { volumes: JSON.stringify([
        { container_path: '/a', local_path: 'one' },
        { container_path: '/b', local_path: 'two' },
      ]) },
    );
    expect(new Set(paths.map((p) => p.k8sPath)).size).toBe(2);
  });
});
