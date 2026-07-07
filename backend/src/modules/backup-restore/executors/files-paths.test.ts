/**
 * Unit tests for the restic-native files-paths restore executor —
 * the Job spec, the selector validation, and the DISPLAY→/source path
 * mapping. The end-to-end restore is covered by the integration-staging
 * harness (E2E).
 */

import { describe, it, expect } from 'vitest';
import { buildFilesPathsJobSpec, validateSelector, pathsOverlap } from './files-paths.js';

describe('pathsOverlap (DB-datadir quiesce gate)', () => {
  const S = 'databases/mysql-abc';
  it('matches an exact datadir path', () => {
    expect(pathsOverlap([S], S)).toBe(true);
  });
  it('matches a restore path INSIDE the datadir (child)', () => {
    expect(pathsOverlap([`${S}/ibdata1`], S)).toBe(true);
  });
  it('matches a restore path that CONTAINS the datadir (ancestor)', () => {
    expect(pathsOverlap(['databases'], S)).toBe(true);
  });
  it('matches a whole-PVC path', () => {
    expect(pathsOverlap([''], S)).toBe(true);
  });
  it('does NOT match an unrelated path', () => {
    expect(pathsOverlap(['var/www/html/index.php'], S)).toBe(false);
  });
  it('does NOT match a sibling with a shared prefix but different segment', () => {
    expect(pathsOverlap(['databases/mysql-abcdef'], S)).toBe(false);
  });
  it('normalises leading ./ and trailing slashes', () => {
    expect(pathsOverlap([`./${S}/`], `${S}/`)).toBe(true);
  });
  it('is false for an empty storagePath (cannot reason)', () => {
    expect(pathsOverlap([S], '')).toBe(false);
  });
});

describe('buildFilesPathsJobSpec', () => {
  const baseInput = {
    jobName: 'rs-files-item-1',
    namespace: 'tenant-acme',
    pvcName: 'tenant-acme-storage',
    tenantId: 'tenant-acme',
    cartId: 'rstr-1',
    itemId: 'item-1',
    credsSecretName: 'rs-files-creds-item1',
    snapshotId: 'a'.repeat(64),
    includePaths: [] as string[],
    jobImage: 'ghcr.io/insulahq/insula/tenant-backup-tools:latest',
  };

  it('runs in the tenant namespace and mounts the tenant PVC RW at /source', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as {
      metadata: { namespace: string };
      spec: { template: { spec: {
        volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
        containers: Array<{ volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
      } } };
    };
    expect(spec.metadata.namespace).toBe('tenant-acme');
    const target = spec.spec.template.spec.volumes.find((v) => v.name === 'source');
    expect(target?.persistentVolumeClaim?.claimName).toBe('tenant-acme-storage');
    const mount = spec.spec.template.spec.containers[0]!.volumeMounts.find((m) => m.name === 'source');
    expect(mount?.mountPath).toBe('/source');
    expect(mount?.readOnly).not.toBe(true); // RW
  });

  it('labels with platform.io/component=restore-files so the tightened NetworkPolicy applies', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('restore-files');
    expect(spec.metadata.labels['platform.io/restore-cart']).toBe('rstr-1');
    expect(spec.metadata.labels['platform.io/restore-item']).toBe('item-1');
  });

  it('mounts the creds Secret read-only at /var/run/restic-creds (mode 0400)', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as {
      spec: { template: { spec: {
        containers: Array<{ volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
        volumes: Array<{ name: string; secret?: { secretName: string; defaultMode?: number } }>;
      } } };
    };
    const mount = spec.spec.template.spec.containers[0]!.volumeMounts.find((m) => m.name === 'restic-creds');
    expect(mount?.mountPath).toBe('/var/run/restic-creds');
    expect(mount?.readOnly).toBe(true);
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'restic-creds');
    expect(vol?.secret?.secretName).toBe('rs-files-creds-item1');
    expect(vol?.secret?.defaultMode).toBe(0o400);
  });

  it('runs restic restore --target /restore-tmp --no-lock with NO --include for a full restore', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain(`restic -r "$REPO" restore ${'a'.repeat(64)} --target /restore-tmp`);
    expect(cmd).toContain('--no-lock');
    expect(cmd).not.toContain('--include');
  });

  it('cp -a /restore-tmp/source/. /source/ to overlay onto the live PVC', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('cp -a /restore-tmp/source/. /source/');
  });

  it('passes one --include /source/<path> per requested DISPLAY path', () => {
    const spec = buildFilesPathsJobSpec({
      ...baseInput,
      includePaths: ['/source/var/www/html/index.php', '/source/etc/config.json'],
    }) as { spec: { template: { spec: { containers: Array<{ command: string[] }> } } } };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain(`--include '/source/var/www/html/index.php'`);
    expect(cmd).toContain(`--include '/source/etc/config.json'`);
  });

  it('mounts a /restore-tmp emptyDir staging area', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as {
      spec: { template: { spec: {
        containers: Array<{ volumeMounts: Array<{ name: string; mountPath: string }> }>;
        volumes: Array<{ name: string; emptyDir?: { sizeLimit?: string } }>;
      } } };
    };
    const mount = spec.spec.template.spec.containers[0]!.volumeMounts.find((m) => m.name === 'restore-tmp');
    expect(mount?.mountPath).toBe('/restore-tmp');
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'restore-tmp');
    expect(vol?.emptyDir).toBeDefined();
  });

  it('pins to the supplied node when pinToNode is set', () => {
    const spec = buildFilesPathsJobSpec({ ...baseInput, pinToNode: 'worker-3' }) as {
      spec: { template: { spec: { nodeName?: string } } };
    };
    expect(spec.spec.template.spec.nodeName).toBe('worker-3');
  });
});

describe('validateSelector', () => {
  it('returns [] for a full restore', () => {
    expect(validateSelector({ kind: 'full' })).toEqual([]);
  });

  it('returns the relative DISPLAY paths for a paths selector', () => {
    expect(validateSelector({ kind: 'paths', paths: ['var/www/index.php', 'etc/app.conf'] }))
      .toEqual(['var/www/index.php', 'etc/app.conf']);
  });

  it('normalises a leading ./ to a clean relative path', () => {
    expect(validateSelector({ kind: 'paths', paths: ['./var/www/index.php'] }))
      .toEqual(['var/www/index.php']);
  });

  it('rejects an absolute path', () => {
    expect(() => validateSelector({ kind: 'paths', paths: ['/etc/passwd'] })).toThrow(/absolute path/);
  });

  it('rejects a `..` traversal segment', () => {
    expect(() => validateSelector({ kind: 'paths', paths: ['var/../../etc/passwd'] })).toThrow(/'\.\.'/);
  });

  it('rejects control characters / NUL in a path', () => {
    expect(() => validateSelector({ kind: 'paths', paths: ['var/www/\nx'] })).toThrow(/control/);
    expect(() => validateSelector({ kind: 'paths', paths: ['var/www/\x00x'] })).toThrow(/control/);
  });

  it('ACCEPTS shell-metachar filenames (printable) — they are single-quote-escaped in the Job, never executed', () => {
    // Real tenant filenames hold these: WordPress plugins, numbered archives,
    // a literal `$(...)` in a path is NOT a command substitution because the
    // restore Job single-quote-escapes every --include arg.
    expect(validateSelector({ kind: 'paths', paths: ['var/www/wp-content/plugins/foo (1).php', 'a/b+c[2].zip', 'x/$weird.txt'] }))
      .toEqual(['var/www/wp-content/plugins/foo (1).php', 'a/b+c[2].zip', 'x/$weird.txt']);
  });

  it('rejects an empty path string', () => {
    expect(() => validateSelector({ kind: 'paths', paths: [''] })).toThrow(/non-empty/);
  });

  it('throws for an unsupported selector shape', () => {
    expect(() => validateSelector({ kind: 'paths', paths: [] })).toThrow(/unsupported selector/);
  });
});
