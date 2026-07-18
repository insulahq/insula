import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveDirectStoreForBundle builds a NATIVE store straight from a backup
// target's stored credentials (the migration-source / DR direct-read path,
// bypassing the backup-rclone-shim). It must support every target type + auth
// variation the platform can store: S3 (access+secret key), SSH by KEY, and SSH
// by PASSWORD. CIFS has no in-backend SMB client, so it stays NOT_IMPLEMENTED.
const { s3ctor, sshctor, rclonector } = vi.hoisted(() => ({ s3ctor: vi.fn(), sshctor: vi.fn(), rclonector: vi.fn() }));

vi.mock('../oidc/crypto.js', () => ({ decrypt: (v: string) => `dec(${v})` }));
vi.mock('../tenant-bundles/s3-backup-store.js', () => ({
  S3BackupStore: class { constructor(c: unknown) { s3ctor(c); } },
}));
vi.mock('../tenant-bundles/ssh-backup-store.js', () => ({
  SshBackupStore: class { constructor(c: unknown) { sshctor(c); } },
}));
vi.mock('../tenant-bundles/rclone-backup-store.js', () => ({
  RcloneBackupStore: class { constructor(c: unknown) { rclonector(c); } },
}));

import { resolveDirectStoreForBundle } from './shared.js';

function makeApp(cfg: Record<string, unknown> | null) {
  return {
    db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (cfg ? [cfg] : []) }) }) }) },
    config: { PLATFORM_ENCRYPTION_KEY: '0'.repeat(64) },
    log: { error: () => {}, warn: () => {}, info: () => {} },
  } as never;
}

const sshBase = { id: 'c1', storageType: 'ssh', sshHost: 'box', sshUser: 'u1', sshPath: '/backups', sshPort: 23 };

beforeEach(() => { s3ctor.mockReset(); sshctor.mockReset(); rclonector.mockReset(); });

describe('resolveDirectStoreForBundle — target types + auth variations', () => {
  it('S3 target → S3BackupStore with decrypted keys + class-prefixed path', async () => {
    await resolveDirectStoreForBundle(makeApp({
      id: 'c1', storageType: 's3', s3Bucket: 'b', s3Region: 'r', s3Endpoint: 'https://ep',
      s3AccessKeyEncrypted: 'AK', s3SecretKeyEncrypted: 'SK', s3Prefix: 'pre',
    }), 'c1', { classSubpath: 'tenant' });
    expect(s3ctor).toHaveBeenCalledTimes(1);
    const c = s3ctor.mock.calls[0][0] as Record<string, unknown>;
    expect(c.accessKeyId).toBe('dec(AK)');
    expect(c.secretAccessKey).toBe('dec(SK)');
    expect(c.pathPrefix).toBe('pre/tenant');
  });

  it('SSH KEY target → SshBackupStore with privateKey (no password)', async () => {
    await resolveDirectStoreForBundle(makeApp({ ...sshBase, sshKeyEncrypted: 'KEY', sshPasswordEncrypted: null }), 'c1', { classSubpath: 'tenant' });
    expect(sshctor).toHaveBeenCalledTimes(1);
    const c = sshctor.mock.calls[0][0] as Record<string, unknown>;
    expect(c.privateKey).toBe('dec(KEY)');
    expect(c.password).toBeUndefined();
    // HOME-RELATIVE (leading slash stripped) to match the shim's SFTP write path.
    expect(c.basePath).toBe('backups/tenant');
  });

  it('SSH PASSWORD target → SshBackupStore with password (no privateKey)', async () => {
    await resolveDirectStoreForBundle(makeApp({ ...sshBase, sshKeyEncrypted: null, sshPasswordEncrypted: 'PW' }), 'c1', { classSubpath: 'tenant' });
    expect(sshctor).toHaveBeenCalledTimes(1);
    const c = sshctor.mock.calls[0][0] as Record<string, unknown>;
    expect(c.password).toBe('dec(PW)');
    expect(c.privateKey).toBeUndefined();
  });

  it('SSH target with BOTH → passes both (ssh2 prefers key, falls back to password)', async () => {
    await resolveDirectStoreForBundle(makeApp({ ...sshBase, sshKeyEncrypted: 'KEY', sshPasswordEncrypted: 'PW' }), 'c1');
    const c = sshctor.mock.calls[0][0] as Record<string, unknown>;
    expect(c.privateKey).toBe('dec(KEY)');
    expect(c.password).toBe('dec(PW)');
  });

  it('SSH target with NEITHER key nor password → CONFIG_INVALID', async () => {
    await expect(resolveDirectStoreForBundle(makeApp({ ...sshBase, sshKeyEncrypted: null, sshPasswordEncrypted: null }), 'c1'))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(sshctor).not.toHaveBeenCalled();
  });

  it('CIFS target → RcloneBackupStore (smb via rclone), home-relative to the share', async () => {
    await resolveDirectStoreForBundle(makeApp({
      id: 'c1', name: 'cifsbox', storageType: 'cifs',
      cifsHost: 'nas.example', cifsShare: 'backups', cifsPath: 'sub', cifsUser: 'u1',
      cifsPasswordEncrypted: 'PW', cifsDomain: 'WG', cifsPort: 445,
    }), 'c1', { classSubpath: 'tenant' });
    expect(rclonector).toHaveBeenCalledTimes(1);
    const c = rclonector.mock.calls[0][0] as { rcloneEnv: Record<string, string>; remoteName: string; basePath: string };
    expect(c.remoteName).toBe('src');
    // basePath = <share>[/<path>]/<class> (upstreamRootPath + classSubpath).
    expect(c.basePath).toBe('backups/sub/tenant');
    // Config passed as RCLONE_CONFIG_SRC_* env, from the shim's own renderer.
    expect(c.rcloneEnv.RCLONE_CONFIG_SRC_TYPE).toBe('smb');
    expect(c.rcloneEnv.RCLONE_CONFIG_SRC_HOST).toBe('nas.example');
    expect(c.rcloneEnv.RCLONE_CONFIG_SRC_USER).toBe('u1');
    // password is present + rclone-obscured (not the plaintext dec(PW)).
    expect(c.rcloneEnv.RCLONE_CONFIG_SRC_PASS).toBeDefined();
    expect(c.rcloneEnv.RCLONE_CONFIG_SRC_PASS).not.toBe('dec(PW)');
  });

  it('CIFS target missing required fields → CONFIG_INVALID', async () => {
    await expect(resolveDirectStoreForBundle(makeApp({ id: 'c1', storageType: 'cifs', cifsHost: 'h', cifsShare: 's' }), 'c1'))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(rclonector).not.toHaveBeenCalled();
  });
});
