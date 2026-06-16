/**
 * Files component Job-spec tests (restic-native rewrite, ADR-047).
 *
 * The Job runs `restic backup /source` DIRECTLY against the per-tenant
 * shim-backed repo — no tar, no curl to platform-api. Each on-disk file
 * becomes a restic node (enables tree browse + per-file restore).
 */

import { describe, it, expect } from 'vitest';
import {
  buildFilesComponentJobSpec,
  parseFilesDone,
  buildResticCredsStringData,
  FILES_CAPTURE_ROOT,
} from './files.js';

const TAGS = [
  'bundle-version=2',
  'platform-version=1.2.3',
  'region=example-test',
  'tenant-id=abc',
  'tenant-slug=tenant-abc',
  'bundle-id=bkp-test',
  'component=files',
];

describe('buildFilesComponentJobSpec', () => {
  const baseInput = {
    jobName: 'bk-files-bkp-test',
    namespace: 'tenant-abc',
    pvcName: 'tenant-data-pvc',
    tenantId: 'abc',
    backupId: 'bkp-test',
    jobImage: 'ghcr.io/insulahq/insula/tenant-backup-tools:latest',
    credsSecretName: 'bk-files-creds-bkp-test',
    tags: TAGS,
  };

  it('exports FILES_CAPTURE_ROOT = /source (shared capture root)', () => {
    expect(FILES_CAPTURE_ROOT).toBe('/source');
  });

  it('produces a Job with backoffLimit=0 and ttlSecondsAfterFinished=600', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as { spec: { backoffLimit: number; ttlSecondsAfterFinished: number } };
    expect(spec.spec.backoffLimit).toBe(0);
    expect(spec.spec.ttlSecondsAfterFinished).toBe(600);
  });

  it('uses the tenant-backup-tools image with imagePullPolicy: Always', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ image: string; imagePullPolicy: string }> } } };
    };
    expect(spec.spec.template.spec.containers[0]!.image).toBe('ghcr.io/insulahq/insula/tenant-backup-tools:latest');
    expect(spec.spec.template.spec.containers[0]!.imagePullPolicy).toBe('Always');
  });

  it('mounts the source PVC read-only at /source', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: {
        volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string; readOnly: boolean } }>;
        containers: Array<{ volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
      } } };
    };
    const sourceVol = spec.spec.template.spec.volumes.find((v) => v.name === 'source');
    expect(sourceVol?.persistentVolumeClaim?.claimName).toBe('tenant-data-pvc');
    expect(sourceVol?.persistentVolumeClaim?.readOnly).toBe(true);
    const mount = spec.spec.template.spec.containers[0]!.volumeMounts.find((m) => m.name === 'source');
    expect(mount?.mountPath).toBe('/source');
    expect(mount?.readOnly).toBe(true);
  });

  it('uses platform-tenant-overhead priority class', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { priorityClassName: string } } };
    };
    expect(spec.spec.template.spec.priorityClassName).toBe('platform-tenant-overhead');
  });

  it('labels the Job with backup-id and tenant-id', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('backup-files');
    expect(spec.metadata.labels['platform.io/tenant-id']).toBe('abc');
    expect(spec.metadata.labels['platform.io/backup-id']).toBe('bkp-test');
  });

  it('runs `restic backup /source` directly (no tar, no curl)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('restic -r "$REPO" backup /source');
    expect(cmd).not.toContain('tar cf -');
    expect(cmd).not.toContain('--upload-file');
    expect(cmd).not.toContain('curl');
  });

  it('passes --pack-size 64 and s3.connections=5 and --json', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('--pack-size 64');
    expect(cmd).toContain('--option s3.connections=5');
    expect(cmd).toContain('--json');
  });

  it('passes every snapshot tag as a --tag argument', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    for (const t of TAGS) {
      expect(cmd).toContain(`--tag '${t}'`);
    }
  });

  it('mounts the creds Secret read-only at /var/run/restic-creds (mode 0400)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: {
        containers: Array<{ volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
        volumes: Array<{ name: string; secret?: { secretName: string; defaultMode?: number } }>;
      } } };
    };
    const mount = spec.spec.template.spec.containers[0]!.volumeMounts.find((m) => m.name === 'restic-creds');
    expect(mount?.mountPath).toBe('/var/run/restic-creds');
    expect(mount?.readOnly).toBe(true);
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'restic-creds');
    expect(vol?.secret?.secretName).toBe('bk-files-creds-bkp-test');
    expect(vol?.secret?.defaultMode).toBe(0o400);
  });

  it('reads restic password + repo uri from the mounted creds Secret', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('export RESTIC_PASSWORD="$(cat /var/run/restic-creds/restic_password)"');
    expect(cmd).toContain('REPO="$(cat /var/run/restic-creds/repo_uri)"');
    expect(cmd).toContain('export AWS_ACCESS_KEY_ID="$(cat /var/run/restic-creds/aws_access_key_id)"');
  });

  it('does NOT pipe through tar/gzip and does NOT build a tree.jsonl.gz sidecar', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toMatch(/\|\s*gzip/);
    expect(cmd).not.toContain('tree.jsonl.gz');
  });

  it('parses snapshot_id/total_bytes_processed/total_files_processed from the restic --json summary', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain("grep -o '\"snapshot_id\":\"[0-9a-f]\\{64\\}\"'");
    expect(cmd).toContain("grep -o '\"total_bytes_processed\":[0-9]\\+'");
    expect(cmd).toContain("grep -o '\"total_files_processed\":[0-9]\\+'");
  });

  it('emits FILES_DONE bundleId=<id> snapshot=$SNAP sizeBytes=$SIZE fileCount=$COUNT (unchanged format)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain(`FILES_DONE bundleId=${baseInput.backupId} snapshot=$SNAP`);
    expect(cmd).toContain('sizeBytes=${SIZE:-0}');
    expect(cmd).toContain('fileCount=${COUNT:-0}');
  });

  it('asserts a 64-hex snapshot id is present (loud failure otherwise)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('[ -n "$SNAP" ] || { echo "ERROR: no snapshot_id');
  });

  it('does not embed any S3/SSH credentials literally in the Job script', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toMatch(/BEGIN OPENSSH|BEGIN RSA|AKIA[0-9A-Z]{16}|s3\.amazonaws/i);
  });

  it('pins to the supplied node when pinToNode is set', () => {
    const spec = buildFilesComponentJobSpec({ ...baseInput, pinToNode: 'staging2' }) as {
      spec: { template: { spec: { nodeName?: string } } };
    };
    expect(spec.spec.template.spec.nodeName).toBe('staging2');
  });

  it('omits nodeName when pinToNode is null/undefined', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { nodeName?: string } } };
    };
    expect(spec.spec.template.spec.nodeName).toBeUndefined();
  });

  it('sets activeDeadlineSeconds when supplied; omits when not/non-positive', () => {
    const withDeadline = buildFilesComponentJobSpec({ ...baseInput, activeDeadlineSeconds: 1860 }) as {
      spec: { activeDeadlineSeconds?: number };
    };
    expect(withDeadline.spec.activeDeadlineSeconds).toBe(1860);
    const without = buildFilesComponentJobSpec(baseInput) as { spec: { activeDeadlineSeconds?: number } };
    expect(without.spec.activeDeadlineSeconds).toBeUndefined();
    const zero = buildFilesComponentJobSpec({ ...baseInput, activeDeadlineSeconds: 0 }) as { spec: { activeDeadlineSeconds?: number } };
    expect(zero.spec.activeDeadlineSeconds).toBeUndefined();
  });
});

describe('buildResticCredsStringData', () => {
  it('includes restic_password + repo_uri + aws_* for s3/shim envs', () => {
    const sd = buildResticCredsStringData({
      passwordHex: 'a'.repeat(64),
      repoUri: 's3:http://shim:9000/tenant/restic-files/abc',
      env: {
        AWS_ACCESS_KEY_ID: 'AK',
        AWS_SECRET_ACCESS_KEY: 'SK',
        AWS_DEFAULT_REGION: 'us-east-1',
      },
    });
    expect(sd.restic_password).toBe('a'.repeat(64));
    expect(sd.repo_uri).toBe('s3:http://shim:9000/tenant/restic-files/abc');
    expect(sd.aws_access_key_id).toBe('AK');
    expect(sd.aws_secret_access_key).toBe('SK');
    expect(sd.aws_region).toBe('us-east-1');
  });

  it('omits aws_* keys when the env lacks them (ssh/hostpath targets)', () => {
    const sd = buildResticCredsStringData({
      passwordHex: 'b'.repeat(64),
      repoUri: 'sftp:user@host:restic-files/abc',
      env: {},
    });
    expect(sd.restic_password).toBe('b'.repeat(64));
    expect(sd.repo_uri).toBe('sftp:user@host:restic-files/abc');
    expect('aws_access_key_id' in sd).toBe(false);
    expect('aws_secret_access_key' in sd).toBe(false);
    expect('aws_region' in sd).toBe(false);
  });
});

describe('parseFilesDone', () => {
  const SNAP = 'a'.repeat(64);
  const SNAP2 = 'b'.repeat(64);
  const ok = `FILES_DONE bundleId=bk-test snapshot=${SNAP} sizeBytes=12345 fileCount=7`;

  it('parses a clean FILES_DONE line', () => {
    expect(parseFilesDone(`...\n${ok}\n...`, 'bk-test')).toEqual({
      snapshotId: SNAP,
      sizeBytes: 12345,
      fileCount: 7,
    });
  });

  it('returns null when the bundleId in the line does not match', () => {
    expect(parseFilesDone(ok, 'different-bundle')).toBeNull();
  });

  it('prefers the LAST matching line (most recent run wins)', () => {
    const oldLine = `FILES_DONE bundleId=bk-test snapshot=${SNAP} sizeBytes=10 fileCount=1`;
    const newLine = `FILES_DONE bundleId=bk-test snapshot=${SNAP2} sizeBytes=20 fileCount=2`;
    const res = parseFilesDone(`${oldLine}\n${newLine}\n`, 'bk-test');
    expect(res?.snapshotId).toBe(SNAP2);
    expect(res?.sizeBytes).toBe(20);
  });

  it('rejects truncated/oversized snapshot ids (64-char-only regex)', () => {
    const truncated = `FILES_DONE bundleId=bk-test snapshot=${'a'.repeat(63)} sizeBytes=1 fileCount=1`;
    expect(parseFilesDone(truncated, 'bk-test')).toBeNull();
    const tooLong = `FILES_DONE bundleId=bk-test snapshot=${'a'.repeat(65)} sizeBytes=1 fileCount=1`;
    expect(parseFilesDone(tooLong, 'bk-test')).toBeNull();
  });

  it('returns null on empty log + partial lines', () => {
    expect(parseFilesDone('', 'bk-test')).toBeNull();
    expect(parseFilesDone('FILES_DONE\n', 'bk-test')).toBeNull();
    expect(parseFilesDone('FILES_DONE bundleId=bk-test\n', 'bk-test')).toBeNull();
  });
});
