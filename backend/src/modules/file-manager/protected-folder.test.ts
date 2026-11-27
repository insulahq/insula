import { describe, expect, it } from 'vitest';
import {
  DATABASE_MASK_PATH,
  FM_PLATFORM_CONTAINER,
  PROTECTED_FOLDER_INIT,
  PROTECTED_FOLDER_SCRIPT,
  databaseMaskMount,
  databaseMaskVolume,
  platformFilesContainer,
  protectedFolderDrift,
  protectedFolderInitContainer,
} from './protected-folder.js';

const IMAGE = 'ghcr.io/example/file-manager:1';

/** A template as the current code creates it. */
function current() {
  return {
    initContainers: [protectedFolderInitContainer(IMAGE)],
    containers: [
      { name: 'file-manager', image: IMAGE, volumeMounts: [{ name: 'tenant-storage', mountPath: '/data' }, databaseMaskMount] },
      platformFilesContainer(IMAGE),
    ],
    volumes: [{ name: 'tenant-storage', persistentVolumeClaim: { claimName: 'x' } }, databaseMaskVolume],
  };
}

describe('the protected database folder in the file-manager pod', () => {
  it('masks /data/database read-only', () => {
    expect(databaseMaskMount).toEqual({ name: 'database-mask', mountPath: '/data/database', readOnly: true });
    expect(DATABASE_MASK_PATH).toBe('/data/database');
  });

  it('gives the platform container the unmasked volume and no chroot or mount capability', () => {
    const c = platformFilesContainer(IMAGE) as { name: string; volumeMounts: unknown[]; securityContext: { capabilities: { add: string[]; drop: string[] }; allowPrivilegeEscalation: boolean } };
    expect(c.name).toBe(FM_PLATFORM_CONTAINER);
    expect(c.volumeMounts).toEqual([{ name: 'tenant-storage', mountPath: '/data' }]);
    expect(c.securityContext.capabilities.drop).toEqual(['ALL']);
    expect(c.securityContext.capabilities.add.sort()).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']);
    expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
  });

  it('moves a symlink or file at `database` aside before creating the directory', () => {
    expect(PROTECTED_FOLDER_SCRIPT).toContain('[ -L "$d" ]');
    expect(PROTECTED_FOLDER_SCRIPT).toContain('mkdir -p "$d"');
    const init = protectedFolderInitContainer(IMAGE) as { name: string; command: string[] };
    expect(init.name).toBe(PROTECTED_FOLDER_INIT);
    expect(init.command).toEqual(['sh', '-c', PROTECTED_FOLDER_SCRIPT]);
  });

  it('finds no drift in a current template', () => {
    expect(protectedFolderDrift(current(), IMAGE)).toBeNull();
  });

  it.each([
    ['no mask mount', (t: ReturnType<typeof current>) => { t.containers[0].volumeMounts = [{ name: 'tenant-storage', mountPath: '/data' }]; }],
    ['a writable mask', (t: ReturnType<typeof current>) => { t.containers[0].volumeMounts = [{ name: 'tenant-storage', mountPath: '/data' }, { ...databaseMaskMount, readOnly: false } as never]; }],
    ['no mask volume', (t: ReturnType<typeof current>) => { t.volumes = [t.volumes[0]]; }],
    ['no platform container', (t: ReturnType<typeof current>) => { t.containers = [t.containers[0]]; }],
    ['no init container', (t: ReturnType<typeof current>) => { t.initContainers = []; }],
    ['a shared process namespace', (t: ReturnType<typeof current>) => { (t as { shareProcessNamespace?: boolean }).shareProcessNamespace = true; }],
  ])('reports drift for %s', (_label, mutate) => {
    const t = current();
    mutate(t);
    expect(protectedFolderDrift(t, IMAGE)).not.toBeNull();
  });

  it('reports drift when the platform container runs another image', () => {
    expect(protectedFolderDrift(current(), 'ghcr.io/example/file-manager:2')).toBe('image changed');
  });

  it('reports drift for a template created before the protected folder', () => {
    expect(protectedFolderDrift({ containers: [{ name: 'file-manager', image: IMAGE }] }, IMAGE)).toBe('the database folder is not masked');
  });
});
