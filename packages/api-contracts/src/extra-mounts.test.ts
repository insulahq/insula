import { describe, it, expect } from 'vitest';
import {
  extraMountSchema,
  extraMountsSchema,
  normalizeMountPath,
  mountPathProblem,
  folderProblem,
  MAX_EXTRA_MOUNTS,
} from './extra-mounts.js';

const ok = { folder: 'shared-assets', mount_path: '/var/www/html/media', read_only: false };

describe('normalizeMountPath', () => {
  it('normalises a trailing slash', () => {
    expect(normalizeMountPath('/var/www/html/media/')).toBe('/var/www/html/media');
  });
  it.each(['relative/path', '', '/a//b', '/a/../etc', '/a/./b', '/etc/\0x'])(
    'rejects %j', (p) => expect(normalizeMountPath(p)).toBeNull(),
  );
});

describe('mountPathProblem', () => {
  it('accepts a path nested inside the document root', () => {
    // The headline use case: a shared media folder under the web root.
    expect(mountPathProblem('/var/www/html/media')).toBeNull();
  });
  it('accepts a deep path under an otherwise reserved directory', () => {
    // Deliberately allowed — this is how a tenant gets custom php.ini
    // directives that .user.ini cannot express.
    expect(mountPathProblem('/usr/local/etc/php/conf.d/user')).toBeNull();
  });
  it.each(['/', '/etc', '/usr', '/var', '/usr/local', '/var/www', '/var/lib'])(
    'rejects the image directory %s itself', (p) => {
      expect(mountPathProblem(p)).toMatch(/image's own filesystem/);
    },
  );
  it.each(['/proc', '/sys/kernel', '/dev/shm'])(
    'rejects kernel interface %s', (p) => {
      expect(mountPathProblem(p)).toMatch(/kernel interface/);
    },
  );
  it('rejects traversal', () => {
    expect(mountPathProblem('/var/www/html/../../etc')).toMatch(/absolute path/);
  });
});

describe('folderProblem', () => {
  it('accepts a nested folder', () => expect(folderProblem('media/library/2026')).toBeNull());
  it('rejects an absolute folder', () => expect(folderProblem('/media')).toMatch(/must not start/));
  it('rejects traversal', () => expect(folderProblem('../other-tenant')).toMatch(/segments may use/));
  it('rejects too deep', () => expect(folderProblem('a/b/c/d/e')).toMatch(/levels deep/));
  it('rejects uppercase', () => expect(folderProblem('Media')).toMatch(/segments may use/));
});

describe('extraMountSchema', () => {
  it('defaults read_only to false', () => {
    const parsed = extraMountSchema.parse({ folder: 'x', mount_path: '/srv/x' });
    expect(parsed.read_only).toBe(false);
  });
  it('rejects a traversing folder', () => {
    expect(extraMountSchema.safeParse({ ...ok, folder: '../escape' }).success).toBe(false);
  });
});

describe('extraMountsSchema', () => {
  it('accepts a list of distinct mounts', () => {
    const r = extraMountsSchema.safeParse([ok, { folder: 'b', mount_path: '/srv/b' }]);
    expect(r.success).toBe(true);
  });
  it('rejects two mounts on the same path — k8s would reject the pod', () => {
    const r = extraMountsSchema.safeParse([ok, { ...ok, folder: 'other' }]);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/must be unique/);
  });
  it('treats /a and /a/ as the same path', () => {
    const r = extraMountsSchema.safeParse([
      { folder: 'a', mount_path: '/srv/a' },
      { folder: 'b', mount_path: '/srv/a/' },
    ]);
    expect(r.success).toBe(false);
  });
  it(`caps the list at ${MAX_EXTRA_MOUNTS}`, () => {
    const many = Array.from({ length: MAX_EXTRA_MOUNTS + 1 }, (_, i) => ({
      folder: `f${i}`, mount_path: `/srv/f${i}`,
    }));
    expect(extraMountsSchema.safeParse(many).success).toBe(false);
  });
});
