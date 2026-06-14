import { describe, it, expect } from 'vitest';
import { buildRestoreJobSpec } from './prebundle.js';

/**
 * Two properties of the pre-resize restore Job silently break the
 * destructive shrink if they regress, and neither shows up in a
 * typecheck — pin them here:
 *
 *   1. label `platform.io/component: restore-files` — the ONLY label the
 *      `allow-backup-files-jobs-to-platform-api` NetworkPolicy admits for
 *      egress to platform-api:3000. Wrong label → the curl hangs and the
 *      restore times out with no clue why.
 *   2. UNCOMPRESSED `tar xf -` (NOT `xzf`). The files capture stored a
 *      raw tar (`tar cf - .`, no gzip — restic dedups on raw blocks), so
 *      `restic dump` streams a raw tar. `xzf` would fail "not in gzip
 *      format" on a valid stream.
 */
describe('buildRestoreJobSpec', () => {
  const spec = buildRestoreJobSpec({
    jobName: 'rs-preresize-bkp123',
    namespace: 'tenant-abc',
    pvcName: 'tenant-abc-storage',
    tenantId: 'abc',
    bundleId: 'bkp-123',
    downloadUrl: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-123/files-restic-tar?token=t',
  }) as {
    metadata: { labels: Record<string, string> };
    spec: {
      template: {
        metadata: { labels: Record<string, string> };
        spec: {
          containers: Array<{ command: string[]; volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
          volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
        };
      };
    };
  };

  it('labels the Job restore-files (NetworkPolicy egress to platform-api)', () => {
    expect(spec.metadata.labels['platform.io/component']).toBe('restore-files');
    expect(spec.spec.template.metadata.labels['platform.io/component']).toBe('restore-files');
  });

  it('mounts the target PVC read-write at /target', () => {
    const c = spec.spec.template.spec.containers[0];
    const target = c.volumeMounts.find((m) => m.mountPath === '/target');
    expect(target).toBeTruthy();
    expect(target?.readOnly).toBe(false);
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'target');
    expect(vol?.persistentVolumeClaim?.claimName).toBe('tenant-abc-storage');
  });

  it('extracts an UNCOMPRESSED tar (xf, never xzf)', () => {
    const script = spec.spec.template.spec.containers[0].command.join(' ');
    expect(script).toContain('tar xf - -C /target');
    expect(script).not.toContain('tar xzf');
    expect(script).not.toContain('xz -');
  });

  it('side-channels the curl exit so a truncated dump fails loud', () => {
    const script = spec.spec.template.spec.containers[0].command.join('\n');
    expect(script).toContain('echo $? > /tmp/curl.exit');
    expect(script).toMatch(/CURL_RC/);
    expect(script).toMatch(/TAR_RC/);
  });
});
