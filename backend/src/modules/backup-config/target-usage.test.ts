/**
 * What a target holds per class, and how much room it has — measured on the
 * target itself with rclone.
 */
import { describe, it, expect } from 'vitest';
import type { BackupTargetConfig } from '../backup-rclone-shim/rclone-config.js';
import { measureTarget, remoteFor, type RcloneRunner } from './target-usage.js';

const CIFS: BackupTargetConfig = {
  id: 't1', name: 'Box', storageType: 'cifs',
  cifsHost: 'box.example.test', cifsPort: null, cifsShare: 'backup', cifsUser: 'u', cifsPassword: 'p', cifsDomain: null, cifsPath: 'insula',
};
const S3: BackupTargetConfig = {
  id: 't2', name: 'Bucket', storageType: 's3',
  s3Endpoint: 'https://s3.example.test', s3Bucket: 'bkt', s3Region: null, s3AccessKey: 'ak', s3SecretKey: 'sk', s3Prefix: 'p', s3UsePathStyle: true,
};
const SFTP_KEY: BackupTargetConfig = {
  id: 't3', name: 'Sftp', storageType: 'ssh',
  sshHost: 'sftp.example.test', sshPort: 23, sshUser: 'u', sshKey: '-----BEGIN KEY-----\nAAA\nBBB\n-----END KEY-----\n', sshPassword: null, sshPath: 'backups',
};

type Reply = { code: number; stdout?: string; stderr?: string };
/** A list of replies is answered in turn, the last one repeating. */
function fakeRclone(replies: Record<string, Reply | Reply[]>): { run: RcloneRunner; calls: string[][] } {
  const calls: string[][] = [];
  const asked = new Map<string, number>();
  const run: RcloneRunner = async (args) => {
    calls.push([...args]);
    const key = `${args[0]} ${args[args.length - 1]}`;
    const n = asked.get(key) ?? 0;
    asked.set(key, n + 1);
    const given = replies[key];
    const r = (Array.isArray(given) ? given[Math.min(n, given.length - 1)] : given) ?? { code: 1, stderr: `no fake for ${key}` };
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}
const sizeCalls = (calls: string[][], where: string) => calls.filter((c) => c[0] === 'size' && c[c.length - 1] === where).length;

const ALL_CLASSES: Reply = { code: 0, stdout: 'mail/\nsystem/\ntenant/\n' };
/** What rclone printed when a repository's lock folder vanished mid-walk (measured against Samba). */
const VANISHED: Reply = {
  code: 3,
  stderr: '2026/10/23 10:35:01 ERROR : restic/r7/locks: error listing: directory not found\n'
    + '2026/10/23 10:35:01 NOTICE: Failed to size with 2 errors: last error was: directory not found\n',
};

describe('measureTarget', () => {
  it('sizes every class folder under the target root and reads the free space', async () => {
    const { run, calls } = fakeRclone({
      'lsf usage:backup/insula': { code: 0, stdout: 'mail/\nsystem/\ntenant/\nunrelated/\n' },
      'size usage:backup/insula/system': { code: 0, stdout: '{"count":120,"bytes":3000000000}' },
      'size usage:backup/insula/tenant': { code: 0, stdout: '{"count":90000,"bytes":500000000000}' },
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":4000,"bytes":60000000000}' },
      'about usage:backup/insula': { code: 0, stdout: '{"total":1000000000000,"used":600000000000,"free":400000000000}' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.classes).toEqual({
      system: { bytes: 3_000_000_000, objects: 120 },
      tenant: { bytes: 500_000_000_000, objects: 90_000 },
      mail: { bytes: 60_000_000_000, objects: 4000 },
    });
    expect(u.usedByBackupsBytes).toBe(563_000_000_000);
    expect(u.capacity).toEqual({ totalBytes: 1e12, usedBytes: 6e11, freeBytes: 4e11 });
    expect(u.capacityNote).toBeNull();
    expect(u.errors).toEqual({});
    expect(calls.filter((c) => c[0] !== 'lsf').every((c) => c.includes('--json'))).toBe(true);
    // Restic's lock folders come and go under the walk; they are never walked.
    const sizes = calls.filter((c) => c[0] === 'size');
    expect(sizes).toHaveLength(3);
    expect(sizes.every((c) => c.join(' ').includes('--exclude locks/**'))).toBe(true);
  });

  it('a class the target has no folder for is 0, not an error — and is not walked', async () => {
    const { run, calls } = fakeRclone({
      'lsf usage:backup/insula': { code: 0, stdout: 'mail/\ntenant/\n' },
      'size usage:backup/insula/tenant': { code: 0, stdout: '{"count":1,"bytes":10}' },
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":0,"bytes":0}' },
      'about usage:backup/insula': { code: 0, stdout: '{"total":100,"free":90}' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.classes.system).toEqual({ bytes: 0, objects: 0 });
    expect(u.errors).toEqual({});
    expect(sizeCalls(calls, 'usage:backup/insula/system')).toBe(0);
  });

  it('a folder that vanished during the walk is walked again, not counted as 0', async () => {
    const { run, calls } = fakeRclone({
      'lsf usage:backup/insula': ALL_CLASSES,
      'size usage:backup/insula/system': { code: 0, stdout: '{"count":1,"bytes":5}' },
      'size usage:backup/insula/tenant': [VANISHED, { code: 0, stdout: '{"count":90000,"bytes":138000000000}' }],
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":1,"bytes":7}' },
      'about usage:backup/insula': { code: 0, stdout: '{"total":100,"free":90}' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.classes.tenant).toEqual({ bytes: 138_000_000_000, objects: 90_000 });
    expect(u.errors).toEqual({});
    expect(sizeCalls(calls, 'usage:backup/insula/tenant')).toBe(2);
  });

  it('a class folder that is there but cannot be walked is an error naming the path, never 0', async () => {
    const { run, calls } = fakeRclone({
      'lsf usage:backup/insula': ALL_CLASSES,
      'size usage:backup/insula/system': { code: 0, stdout: '{"count":1,"bytes":5}' },
      'size usage:backup/insula/tenant': VANISHED,
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":1,"bytes":7}' },
      'about usage:backup/insula': { code: 0, stdout: '{"total":100,"used":12,"free":88}' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.classes.tenant).toBeNull();
    expect(u.errors).toEqual({ tenant: 'restic/r7/locks: error listing: directory not found' });
    expect(sizeCalls(calls, 'usage:backup/insula/tenant')).toBe(3);
  });

  it('a root that could not be listed still walks every class — and a failed walk is still an error, not 0', async () => {
    const { run } = fakeRclone({
      'lsf usage:backup/insula': { code: 1, stderr: '2026/10/23 10:00:00 ERROR : connection refused' },
      'size usage:backup/insula/system': { code: 0, stdout: '{"count":1,"bytes":5}' },
      'size usage:backup/insula/tenant': VANISHED,
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":1,"bytes":7}' },
      'about usage:backup/insula': { code: 0, stdout: '{"total":100,"free":90}' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.classes.system).toEqual({ bytes: 5, objects: 1 });
    expect(u.classes.tenant).toBeNull();
    expect(Object.keys(u.errors)).toEqual(['tenant']);
  });

  it('only rclone\'s "directory not found" makes a root absent — another "not found" zeroes nothing', async () => {
    const { run, calls } = fakeRclone({
      'lsf usage:backup/insula': { code: 1, stderr: '2026/10/23 10:00:00 ERROR : couldn\'t connect: session setup failed: user not found' },
      'size usage:backup/insula/system': { code: 1, stderr: '2026/10/23 10:00:00 ERROR : couldn\'t connect: session setup failed: user not found' },
      'size usage:backup/insula/tenant': { code: 1, stderr: '2026/10/23 10:00:00 ERROR : couldn\'t connect: session setup failed: user not found' },
      'size usage:backup/insula/mail': { code: 1, stderr: '2026/10/23 10:00:00 ERROR : couldn\'t connect: session setup failed: user not found' },
      'about usage:backup/insula': { code: 1, stderr: '2026/10/23 10:00:00 ERROR : couldn\'t connect: session setup failed: user not found' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.classes).toEqual({ system: null, tenant: null, mail: null });
    expect(u.errors.tenant).toBe('couldn\'t connect: session setup failed: user not found');
    // Not a vanished folder: not walked again.
    expect(sizeCalls(calls, 'usage:backup/insula/tenant')).toBe(1);
  });

  it('a class that could not be listed is null with its reason, and left out of the sum', async () => {
    const { run, calls } = fakeRclone({
      'lsf usage:backup/insula': ALL_CLASSES,
      'size usage:backup/insula/system': { code: 0, stdout: '{"count":1,"bytes":5}' },
      'size usage:backup/insula/tenant': { code: 1, stderr: '2026/10/19 12:00:00 ERROR : connection reset by peer' },
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":1,"bytes":7}' },
      'about usage:backup/insula': { code: 0, stdout: '{"total":100,"used":12,"free":88}' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.classes.tenant).toBeNull();
    expect(u.errors).toEqual({ tenant: 'connection reset by peer' });
    expect(u.usedByBackupsBytes).toBe(12);
    expect(sizeCalls(calls, 'usage:backup/insula/tenant')).toBe(1);
  });

  it('a walk that timed out is not walked again', async () => {
    const { run, calls } = fakeRclone({
      'lsf usage:backup/insula': ALL_CLASSES,
      'size usage:backup/insula/system': { code: 0, stdout: '{"count":1,"bytes":5}' },
      'size usage:backup/insula/tenant': { code: 124, stderr: '\nrclone timed out after 1800s' },
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":1,"bytes":7}' },
      'about usage:backup/insula': { code: 0, stdout: '{"total":100,"free":90}' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.errors).toEqual({ tenant: 'rclone timed out after 1800s' });
    expect(sizeCalls(calls, 'usage:backup/insula/tenant')).toBe(1);
  });

  it('S3 reports no free space — said in words, and not asked', async () => {
    const { run, calls } = fakeRclone({
      'lsf usage:bkt/p': ALL_CLASSES,
      'size usage:bkt/p/system': { code: 0, stdout: '{"count":1,"bytes":1}' },
      'size usage:bkt/p/tenant': { code: 0, stdout: '{"count":1,"bytes":1}' },
      'size usage:bkt/p/mail': { code: 0, stdout: '{"count":1,"bytes":1}' },
    });
    const u = await measureTarget(S3, run);
    expect(u.capacity).toBeNull();
    expect(u.capacityNote).toBe('S3 storage does not report free space');
    expect(calls.some((c) => c[0] === 'about')).toBe(false);
  });

  it('a backup folder that does not exist yet asks the share for its space', async () => {
    // Measured against Samba: `about` on a missing path fails with
    // "statfs …: file does not exist"; on the share it answers.
    const { run, calls } = fakeRclone({
      'lsf usage:backup/insula': { code: 3, stderr: '2026/10/23 10:00:00 ERROR : : error listing: directory not found' },
      'about usage:backup/insula': { code: 1, stderr: 'NOTICE: Failed to about: about call failed: statfs insula: file does not exist' },
      'about usage:backup': { code: 0, stdout: '{"total": 2000, "used": 700, "free": 1300}' },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.classes).toEqual({ system: { bytes: 0, objects: 0 }, tenant: { bytes: 0, objects: 0 }, mail: { bytes: 0, objects: 0 } });
    expect(u.errors).toEqual({});
    expect(calls.some((c) => c[0] === 'size')).toBe(false);
    expect(u.capacity).toEqual({ totalBytes: 2000, usedBytes: 700, freeBytes: 1300 });
    expect(calls.filter((c) => c[0] === 'about').map((c) => c[c.length - 1])).toEqual(['usage:backup/insula', 'usage:backup']);
  });

  it('a server that cannot report space says so instead of failing the measurement', async () => {
    const { run } = fakeRclone({
      'size usage:backup/insula/system': { code: 0, stdout: '{"count":1,"bytes":1}' },
      'size usage:backup/insula/tenant': { code: 0, stdout: '{"count":1,"bytes":1}' },
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":1,"bytes":1}' },
      'about usage:backup/insula': { code: 1, stderr: "ERROR : smb root 'backup/insula': doesn't support about" },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.capacity).toBeNull();
    expect(u.capacityNote).toBe('this server does not report free space');
    expect(u.usedByBackupsBytes).toBe(3);
  });

  it('free space that could not be read gives rclone\'s final reason, not an earlier retry\'s', async () => {
    const { run } = fakeRclone({
      'lsf usage:backup/insula': ALL_CLASSES,
      'size usage:backup/insula/system': { code: 0, stdout: '{"count":1,"bytes":1}' },
      'size usage:backup/insula/tenant': { code: 0, stdout: '{"count":1,"bytes":1}' },
      'size usage:backup/insula/mail': { code: 0, stdout: '{"count":1,"bytes":1}' },
      'about usage:backup/insula': {
        code: 1,
        stderr: '2026/10/23 10:00:00 ERROR : low level retry 1/3: i/o timeout\n'
          + '2026/10/23 10:00:05 NOTICE: Failed to about: about call failed: permission denied\n',
      },
    });
    const u = await measureTarget(CIFS, run);
    expect(u.capacityNote).toBe('free space could not be read: Failed to about: about call failed: permission denied');
  });
});

describe('remoteFor', () => {
  it('hands an SFTP key over inline, since the shim\'s key file does not exist here', () => {
    const { env, root } = remoteFor(SFTP_KEY);
    expect(root).toBe('backups');
    expect(env.RCLONE_CONFIG_USAGE_TYPE).toBe('sftp');
    expect(env.RCLONE_CONFIG_USAGE_KEY_FILE).toBeUndefined();
    expect(env.RCLONE_CONFIG_USAGE_KEY_PEM).toBe('-----BEGIN KEY-----\\nAAA\\nBBB\\n-----END KEY-----');
  });

  it('never writes a password in the clear', () => {
    const { env } = remoteFor(CIFS);
    expect(env.RCLONE_CONFIG_USAGE_TYPE).toBe('smb');
    expect(env.RCLONE_CONFIG_USAGE_PASS).toBeDefined();
    expect(env.RCLONE_CONFIG_USAGE_PASS).not.toBe('p');
  });
});
