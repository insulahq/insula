import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../backup-rclone-shim/service.js', () => ({
  loadShimAssignments: vi.fn(),
}));
vi.mock('../system-settings/cluster-id.js', () => ({
  getClusterId: vi.fn(),
}));

import { loadShimAssignments } from '../backup-rclone-shim/service.js';
import { getClusterId } from '../system-settings/cluster-id.js';
import { upstreamRootPath, type BackupTargetConfig } from '../backup-rclone-shim/rclone-config.js';
import { buildDrSystemTargetDescriptor } from './dr-target-descriptor.js';

const fakeDb = {} as never;
const CID = '28476af6-1111-2222-3333-444455556666';

function mockAssignments(assignments: Array<{ className: string; target: BackupTargetConfig }>): void {
  (loadShimAssignments as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    assignments,
    shadowed: [],
    disabledAssignments: [],
    orphanedAssignments: [],
  });
}

describe('buildDrSystemTargetDescriptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getClusterId as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(CID);
  });

  it('returns null when no system target is bound', async () => {
    mockAssignments([
      { className: 'mail', target: { id: 'm', name: 'mail', storageType: 's3', s3Bucket: 'b', s3Endpoint: 'e', s3AccessKey: 'a', s3SecretKey: 's' } },
    ]);
    expect(await buildDrSystemTargetDescriptor(fakeDb, 'enc')).toBeNull();
  });

  it('S3: carries the decrypted creds + the etcd key prefix matches the shim upstream path', async () => {
    // s3Prefix carries slashes to exercise the joiner normalisation.
    const target: BackupTargetConfig = {
      id: 't1', name: 'system-s3', storageType: 's3',
      s3Endpoint: 'https://fsn1.example-objectstorage.test', s3Region: 'fsn1',
      s3Bucket: 'k8s-backups', s3AccessKey: 'AKIAEXAMPLE', s3SecretKey: 'topsecret',
      s3Prefix: '/platform-backups/', s3UsePathStyle: true,
    };
    mockAssignments([{ className: 'system', target }]);

    const d = await buildDrSystemTargetDescriptor(fakeDb, 'enc');
    expect(d).not.toBeNull();
    expect(d!.storageType).toBe('s3');
    expect(d!.clusterId).toBe(CID);
    expect(d!.s3Bucket).toBe('k8s-backups');
    expect(d!.s3SecretKey).toBe('topsecret'); // the descriptor's whole purpose: decrypted creds offline
    expect(d!.s3UsePathStyle).toBe(true);
    // DRIFT GUARD: the offline path `<bucket>/<etcdKeyPrefix>` MUST equal the
    // shim's own upstream layout `<root>/system/etcd/<clusterId>`. Tying it to
    // the shim's source-of-truth `upstreamRootPath` catches any path drift.
    expect(`${d!.s3Bucket}/${d!.etcdKeyPrefix}`).toBe(`${upstreamRootPath(target)}/system/etcd/${CID}`);
  });

  it('S3 with no operator prefix: etcdKeyPrefix has no leading slash', async () => {
    const target: BackupTargetConfig = {
      id: 't2', name: 'sys', storageType: 's3',
      s3Endpoint: 'e', s3Bucket: 'bkt', s3AccessKey: 'a', s3SecretKey: 's',
    };
    mockAssignments([{ className: 'system', target }]);
    const d = await buildDrSystemTargetDescriptor(fakeDb, 'enc', CID);
    expect(d!.etcdKeyPrefix).toBe(`system/etcd/${CID}`);
    expect(`${d!.s3Bucket}/${d!.etcdKeyPrefix}`).toBe(`${upstreamRootPath(target)}/system/etcd/${CID}`);
  });

  it('legacy s3UsePathStyle=null defaults to path-style true', async () => {
    const target: BackupTargetConfig = {
      id: 't3', name: 'sys', storageType: 's3',
      s3Endpoint: 'e', s3Bucket: 'bkt', s3AccessKey: 'a', s3SecretKey: 's', s3UsePathStyle: null,
    };
    mockAssignments([{ className: 'system', target }]);
    const d = await buildDrSystemTargetDescriptor(fakeDb, 'enc');
    expect(d!.s3UsePathStyle).toBe(true);
  });

  it('SFTP: descriptor carries ssh fields + a namespaced etcd path', async () => {
    const target: BackupTargetConfig = {
      id: 't4', name: 'sys-sftp', storageType: 'ssh',
      sshHost: 'sftp.example.test', sshPort: 23, sshUser: 'u', sshKey: 'PEM', sshPath: 'backups',
    };
    mockAssignments([{ className: 'system', target }]);
    const d = await buildDrSystemTargetDescriptor(fakeDb, 'enc');
    expect(d!.storageType).toBe('ssh');
    expect(d!.sshHost).toBe('sftp.example.test');
    expect(d!.etcdKeyPrefix).toBe(`backups/system/etcd/${CID}`);
  });
});
