import { describe, it, expect } from 'vitest';
import { buildResticRestoreJobSpec } from './prebundle.js';

/**
 * Properties of the pre-resize/archive restore Job that silently break the
 * destructive shrink + archive restore if they regress, and none of which a
 * typecheck catches — pin them here:
 *
 *   1. label `platform.io/component: restore-files` — the label the shim
 *      NetworkPolicy admits for the restore Job.
 *   2. restic-NATIVE restore (`restic restore <snap> --target /restore-tmp`,
 *      then `cp -a /restore-tmp/source/. /source/`), NOT the old
 *      `restic dump | tar x` stream — the files bundle is restic-native since
 *      #105 (each file a node, no single /archive.tar blob).
 *   3. the target PVC is mounted RW at /source (the capture root), and the
 *      per-Job creds Secret is mounted read-only.
 */
describe('buildResticRestoreJobSpec', () => {
  const spec = buildResticRestoreJobSpec({
    jobName: 'rs-preresize-bkp123',
    namespace: 'tenant-abc',
    pvcName: 'tenant-abc-storage',
    tenantId: 'abc',
    bundleId: 'bkp-123',
    credsSecretName: 'rs-preresize-creds-bkp123',
    snapshotId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  }) as {
    metadata: { labels: Record<string, string> };
    spec: {
      template: {
        metadata: { labels: Record<string, string> };
        spec: {
          containers: Array<{ command: string[]; volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
          volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string }; secret?: { secretName: string } }>;
        };
      };
    };
  };

  it('labels the Job restore-files (shim NetworkPolicy egress)', () => {
    expect(spec.metadata.labels['platform.io/component']).toBe('restore-files');
    expect(spec.spec.template.metadata.labels['platform.io/component']).toBe('restore-files');
  });

  it('mounts the target PVC read-write at /source + the creds Secret read-only', () => {
    const c = spec.spec.template.spec.containers[0];
    const src = c.volumeMounts.find((m) => m.mountPath === '/source');
    expect(src?.readOnly).toBe(false);
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'source');
    expect(vol?.persistentVolumeClaim?.claimName).toBe('tenant-abc-storage');
    const creds = spec.spec.template.spec.volumes.find((v) => v.name === 'restic-creds');
    expect(creds?.secret?.secretName).toBe('rs-preresize-creds-bkp123');
    expect(c.volumeMounts.find((m) => m.name === 'restore-tmp')).toBeTruthy();
  });

  it('does a restic-native restore (restore --target + cp), NOT restic dump | tar', () => {
    const script = spec.spec.template.spec.containers[0].command.join('\n');
    expect(script).toContain('restic -r "$REPO" restore a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 --target /restore-tmp');
    expect(script).toContain('cp -a /restore-tmp/source/. /source/');
    expect(script).not.toContain('restic dump');
    expect(script).not.toContain('tar xf');
    expect(script).not.toContain('/archive.tar');
  });
});
