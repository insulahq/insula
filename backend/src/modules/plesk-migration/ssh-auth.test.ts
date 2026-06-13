import { describe, it, expect, beforeEach } from 'vitest';
import { sourceAuthEnv, sourceAuthKeyVolume, sourceAuthSecretData } from './ssh-auth.js';
import { encrypt } from '../oidc/crypto.js';

const ENC_KEY = 'b'.repeat(64);
beforeEach(() => { process.env.PLATFORM_ENCRYPTION_KEY = ENC_KEY; });

type Row = Parameters<typeof sourceAuthSecretData>[0];
function row(over: Partial<Row>): Row {
  return {
    id: 'srcid123', name: 's', hostname: 'plesk.example.test', sshPort: 22, sshUser: 'root',
    authMethod: 'key', sshKeyEncrypted: null, sshPasswordEncrypted: null,
    pleskVersion: null, passwordStorage: null, lastDiscoveredAt: null,
    status: 'registered', createdBy: null, createdAt: new Date(),
    ...over,
  } as Row;
}

describe('sourceAuthEnv', () => {
  it('key auth → only the method marker', () => {
    expect(sourceAuthEnv(row({ authMethod: 'key' }), 'sec')).toEqual([{ name: 'PLESK_AUTH_METHOD', value: 'key' }]);
  });
  it('password auth → method marker + SSHPASS from the Secret', () => {
    const env = sourceAuthEnv(row({ authMethod: 'password' }), 'sec') as Array<Record<string, unknown>>;
    expect(env[0]).toEqual({ name: 'PLESK_AUTH_METHOD', value: 'password' });
    expect(env[1]).toMatchObject({ name: 'SSHPASS', valueFrom: { secretKeyRef: { name: 'sec', key: 'ssh_password' } } });
  });
});

describe('sourceAuthKeyVolume', () => {
  it('key auth → mounts the id_rsa Secret', () => {
    const v = sourceAuthKeyVolume(row({ authMethod: 'key' }), 'sec');
    expect(v.volumeMounts).toEqual([{ name: 'plesk-key', mountPath: '/etc/plesk-key', readOnly: true }]);
    expect(v.volumes[0]).toMatchObject({ name: 'plesk-key', secret: { secretName: 'sec' } });
  });
  it('password auth → no key volume/mount', () => {
    const v = sourceAuthKeyVolume(row({ authMethod: 'password' }), 'sec');
    expect(v.volumes).toEqual([]);
    expect(v.volumeMounts).toEqual([]);
  });
});

describe('sourceAuthSecretData', () => {
  it('key auth → id_rsa (decrypted + trailing newline normalized)', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc';
    const data = sourceAuthSecretData(row({ authMethod: 'key', sshKeyEncrypted: encrypt(pem, ENC_KEY) }));
    expect(Object.keys(data)).toEqual(['id_rsa']);
    expect(data.id_rsa.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(data.id_rsa.endsWith('\n')).toBe(true);
  });
  it('password auth → ssh_password (decrypted)', () => {
    const data = sourceAuthSecretData(row({ authMethod: 'password', sshPasswordEncrypted: encrypt('s3cr3t!', ENC_KEY) }));
    expect(data).toEqual({ ssh_password: 's3cr3t!' });
  });
});
