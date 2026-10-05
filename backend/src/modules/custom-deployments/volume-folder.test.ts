import { describe, it, expect } from 'vitest';
import { parseCompose } from './compose-parser.js';
import { volumeSubPath } from './k8s-deployer.js';

const stack = (volumeDef: string): string => `
services:
  web:
    image: nginx:1.27.3
    volumes:
      - site:/usr/share/nginx/html
volumes:
  site:${volumeDef}
`;

const parse = (yaml: string) => parseCompose({ composeYaml: yaml, envFiles: {} });
const errors = (r: ReturnType<typeof parse>) => r.issues.filter((i) => i.severity === 'error');

describe('compose named volume → a folder on tenant storage', () => {
  it('Compose\'s bind idiom selects the folder (relative to the storage root)', () => {
    const r = parse(stack(`
    driver_opts:
      type: none
      o: bind
      device: sites/example.com
`));
    expect(errors(r)).toEqual([]);
    expect(r.spec?.volumes.site).toEqual({ folder: 'sites/example.com' });
  });

  it('a trailing slash is tolerated', () => {
    expect(parse(stack(`
    driver_opts: { device: shared-assets/ }
`)).spec?.volumes.site).toEqual({ folder: 'shared-assets' });
  });

  it('without driver_opts the volume stays in the deployment\'s own folder', () => {
    expect(parse(stack(' {}')).spec?.volumes.site).toEqual({});
  });

  it.each([
    ['an absolute host path', '/srv/www', /must not start with "\/"/],
    ['a traversal', 'sites/../../etc', /letters, digits/],
    ['a folder five levels deep', 'a/b/c/d/e', /levels deep/],
  ])('refuses %s', (_label, device, message) => {
    const r = parse(stack(`
    driver_opts: { type: none, o: bind, device: "${device}" }
`));
    const e = errors(r).find((i) => i.code === 'VOLUME_FOLDER_INVALID');
    expect(e?.message).toMatch(message);
    expect(e?.path).toBe('volumes.site.driver_opts.device');
  });

  it('driver_opts without a device is an error, not silently ignored', () => {
    const r = parse(stack(`
    driver_opts: { type: nfs, o: addr=203.0.113.5 }
`));
    expect(errors(r).map((i) => i.code)).toContain('VOLUME_FOLDER_INVALID');
  });

  it('unknown driver_opts keys next to device are flagged as ignored', () => {
    const r = parse(stack(`
    driver_opts: { device: shared, uid: "1000" }
`));
    expect(r.spec?.volumes.site).toEqual({ folder: 'shared' });
    expect(r.issues.find((i) => i.code === 'COMPOSE_FIELD_IGNORED')?.message).toMatch(/uid/);
  });
});

describe('volumeSubPath', () => {
  const base = { storageSubPath: 'custom-deployment/blog' };
  it('uses the chosen folder, else the deployment folder', () => {
    const spec = { volumes: { site: { folder: 'sites/example.com' }, cache: {} } } as never;
    expect(volumeSubPath({ ...base, spec }, 'site')).toBe('sites/example.com');
    expect(volumeSubPath({ ...base, spec }, 'cache')).toBe('custom-deployment/blog/cache');
  });
});
