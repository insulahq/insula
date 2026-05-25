/**
 * Renderer tests for R-X20 (always-combined rclone.conf).
 *
 * The renderer's output shape changed in R-X20: instead of an env
 * file with UPSTREAM_TYPE + per-type vars, the renderer now emits
 * a full rclone.conf string with N per-target sections plus a
 * [combined] section that maps each class to its target's path
 * with a class-name suffix.
 *
 * `upstreamEnv` now carries ONLY the shim's HKDF-derived
 * ROOT_ACCESS_KEY / ROOT_SECRET_KEY — all upstream credentials live
 * in `rcloneConf`.
 */
import { describe, it, expect } from 'vitest';
import {
  renderShimConfig,
  computeInputHash,
  type BackupClass,
  type BackupTargetConfig,
  type ClassAssignment,
} from './rclone-config.js';

const FIXED_KEY = Buffer.alloc(32);
for (let i = 0; i < 32; i++) FIXED_KEY[i] = i;

const s3Target: BackupTargetConfig = {
  id: 't-s3',
  name: 'staging-s3',
  storageType: 's3',
  s3Endpoint: 'https://fsn1.your-objectstorage.com',
  s3Bucket: 'k8s-staging',
  s3Region: 'fsn1',
  s3AccessKey: 'AKIATEST',
  s3SecretKey: 'secretpass',
  s3Prefix: null,
};

const sftpTarget: BackupTargetConfig = {
  id: 't-sftp',
  name: 'hbox-sftp',
  storageType: 'ssh',
  sshHost: 'u335448.your-storagebox.de',
  sshPort: 23,
  sshUser: 'u335448',
  sshPassword: 'p@ss',
  sshKey: null,
  sshPath: 'backup',
};

const cifsTarget: BackupTargetConfig = {
  id: 't-cifs',
  name: 'hbox-cifs',
  storageType: 'cifs',
  cifsHost: 'u335448.your-storagebox.de',
  cifsPort: 445,
  cifsShare: 'u335448',
  cifsUser: 'u335448',
  cifsPassword: 'p@ss',
  cifsDomain: null,
  cifsPath: 'backup',
};

function assign(className: BackupClass, target: BackupTargetConfig): ClassAssignment {
  return { className, target };
}

// ───────────────────────────────────────────────────────────────────────────
// Empty / shim creds
// ───────────────────────────────────────────────────────────────────────────

describe('renderShimConfig — empty assignments', () => {
  const out = renderShimConfig(FIXED_KEY, []);

  it('produces empty classesTxt + minimal env', () => {
    expect(out.classesTxt).toBe('');
    expect(out.assignedClasses).toEqual([]);
  });

  it('rcloneConf is a comment-only placeholder', () => {
    expect(out.rcloneConf).toMatch(/no.*assignments/);
    expect(out.rcloneConf).not.toMatch(/\[combined\]/);
    expect(out.rcloneConf).not.toMatch(/\[upstream_/);
  });

  it('still derives shimAccessKey + shimSecretKey + fingerprint', () => {
    expect(out.shimAccessKey).toMatch(/^[0-9a-f]{20}$/);
    expect(out.shimSecretKey).toMatch(/^[0-9a-f]{80}$/);
    expect(out.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('renderShimConfig — shim creds plumbed into upstream.env', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);

  it('emits ROOT_ACCESS_KEY + ROOT_SECRET_KEY from HKDF', () => {
    expect(out.upstreamEnv).toContain(`ROOT_ACCESS_KEY='${out.shimAccessKey}'`);
    expect(out.upstreamEnv).toContain(`ROOT_SECRET_KEY='${out.shimSecretKey}'`);
  });

  it('does NOT contain upstream credentials (those are in rclone.conf)', () => {
    expect(out.upstreamEnv).not.toContain('UPSTREAM_TYPE');
    expect(out.upstreamEnv).not.toContain('UPSTREAM_S3_BUCKET');
    expect(out.upstreamEnv).not.toContain(s3Target.s3SecretKey!);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Single-target S3 — combined section structure
// ───────────────────────────────────────────────────────────────────────────

describe('renderShimConfig — single S3 target', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);

  it('rcloneConf contains an [upstream_<hash>] section', () => {
    expect(out.rcloneConf).toMatch(/^\[upstream_[0-9a-f]{8}\]$/m);
    expect(out.rcloneConf).toMatch(/^type = s3$/m);
    expect(out.rcloneConf).toContain('endpoint = https://fsn1.your-objectstorage.com');
    expect(out.rcloneConf).toContain('access_key_id = AKIATEST');
    expect(out.rcloneConf).toContain('secret_access_key = secretpass');
    expect(out.rcloneConf).toContain('force_path_style = true');
    expect(out.rcloneConf).toContain('region = fsn1');
  });

  it('rcloneConf contains a [combined] section mapping system → upstream/system', () => {
    expect(out.rcloneConf).toMatch(/^\[combined\]$/m);
    expect(out.rcloneConf).toMatch(/^type = combine$/m);
    expect(out.rcloneConf).toMatch(/upstreams = system=upstream_[0-9a-f]{8}:k8s-staging\/system$/m);
  });

  it('includes s3Prefix in upstream root when set', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Prefix: 'staging' };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.rcloneConf).toMatch(/upstreams = system=upstream_[0-9a-f]{8}:k8s-staging\/staging\/system$/m);
  });

  it('strips leading/trailing slashes from s3Prefix', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Prefix: '/staging/' };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.rcloneConf).toContain('k8s-staging/staging/system');
    expect(r.rcloneConf).not.toContain('k8s-staging//staging');
  });

  it('preserves middle slashes in multi-segment s3Prefix', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Prefix: 'backups/2026/staging' };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.rcloneConf).toContain('k8s-staging/backups/2026/staging/system');
  });

  it('defaults region to us-east-1 when s3Region is null', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Region: null };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.rcloneConf).toContain('region = us-east-1');
  });

  it('force_path_style=true by default; false when s3UsePathStyle explicitly false', () => {
    const r1 = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);
    expect(r1.rcloneConf).toContain('force_path_style = true');
    const t: BackupTargetConfig = { ...s3Target, s3UsePathStyle: false };
    const r2 = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r2.rcloneConf).toContain('force_path_style = false');
  });

  it('rejects S3 target missing bucket', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Bucket: null };
    expect(() => renderShimConfig(FIXED_KEY, [assign('system', t)])).toThrow(
      /missing required/,
    );
  });

  it('rejects S3 target missing endpoint', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Endpoint: null };
    expect(() => renderShimConfig(FIXED_KEY, [assign('system', t)])).toThrow(
      /missing required/,
    );
  });

  it('rejects S3 target missing credentials', () => {
    expect(() =>
      renderShimConfig(FIXED_KEY, [assign('system', { ...s3Target, s3SecretKey: null })]),
    ).toThrow(/missing required/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SFTP — key vs password, obscured pass
// ───────────────────────────────────────────────────────────────────────────

describe('renderShimConfig — SFTP key auth', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----';
  const withKey: BackupTargetConfig = { ...sftpTarget, sshPassword: null, sshKey: pem };
  const out = renderShimConfig(FIXED_KEY, [assign('tenant', withKey)]);

  it('emits type=sftp + host/user/port', () => {
    expect(out.rcloneConf).toMatch(/^type = sftp$/m);
    expect(out.rcloneConf).toContain('host = u335448.your-storagebox.de');
    expect(out.rcloneConf).toContain('user = u335448');
    expect(out.rcloneConf).toContain('port = 23');
    expect(out.rcloneConf).toContain('shell_type = unix');
  });

  it('references the PEM via key_file = /etc/rclone/ssh-keys/<section>.pem', () => {
    expect(out.rcloneConf).toMatch(
      /^key_file = \/etc\/rclone\/ssh-keys\/upstream_[0-9a-f]{8}\.pem$/m,
    );
    expect(out.rcloneConf).not.toContain('pass =');
  });

  it('emits one sshKeyMaterialization with fileName matching key_file', () => {
    expect(out.sshKeyMaterializations).toHaveLength(1);
    expect(out.sshKeyMaterializations[0].pemContent).toBe(pem);
    expect(out.sshKeyMaterializations[0].fileName).toMatch(/^upstream_[0-9a-f]{8}\.pem$/);
  });

  it('combined alias targets sshPath with class suffix', () => {
    expect(out.rcloneConf).toMatch(/upstreams = tenant=upstream_[0-9a-f]{8}:backup\/tenant$/m);
  });
});

describe('renderShimConfig — SFTP password auth', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('tenant', sftpTarget)]);

  it('emits pass = (obscured) — NOT plaintext', () => {
    expect(out.rcloneConf).toMatch(/^pass = [A-Za-z0-9_-]+$/m);
    expect(out.rcloneConf).not.toContain(`pass = ${sftpTarget.sshPassword}`);
  });

  it('does NOT emit key_file when password auth', () => {
    expect(out.rcloneConf).not.toContain('key_file =');
  });

  it('emits no sshKeyMaterializations when password auth', () => {
    expect(out.sshKeyMaterializations).toEqual([]);
  });

  it('rejects SFTP target missing host', () => {
    const t: BackupTargetConfig = { ...sftpTarget, sshHost: null };
    expect(() => renderShimConfig(FIXED_KEY, [assign('tenant', t)])).toThrow(
      /missing required/,
    );
  });

  it('rejects SFTP target missing both key and password', () => {
    const t: BackupTargetConfig = { ...sftpTarget, sshKey: null, sshPassword: null };
    expect(() => renderShimConfig(FIXED_KEY, [assign('tenant', t)])).toThrow(
      /ssh_key or ssh_password/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CIFS / SMB
// ───────────────────────────────────────────────────────────────────────────

describe('renderShimConfig — CIFS', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('mail', cifsTarget)]);

  it('emits type=smb (rclone backend name)', () => {
    expect(out.rcloneConf).toMatch(/^type = smb$/m);
    expect(out.rcloneConf).toContain('host = u335448.your-storagebox.de');
    expect(out.rcloneConf).toContain('user = u335448');
    expect(out.rcloneConf).toContain('port = 445');
  });

  it('pass is obscured', () => {
    expect(out.rcloneConf).toMatch(/^pass = [A-Za-z0-9_-]+$/m);
    expect(out.rcloneConf).not.toContain(`pass = ${cifsTarget.cifsPassword}`);
  });

  it('combined alias scopes to share + path + class suffix', () => {
    expect(out.rcloneConf).toMatch(/upstreams = mail=upstream_[0-9a-f]{8}:u335448\/backup\/mail$/m);
  });

  it('emits domain when set', () => {
    const t: BackupTargetConfig = { ...cifsTarget, cifsDomain: 'WORKGROUP' };
    const r = renderShimConfig(FIXED_KEY, [assign('mail', t)]);
    expect(r.rcloneConf).toContain('domain = WORKGROUP');
  });

  it('rejects CIFS target missing required fields', () => {
    expect(() =>
      renderShimConfig(FIXED_KEY, [assign('mail', { ...cifsTarget, cifsPassword: null })]),
    ).toThrow(/missing required/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Multi-class shared target — single [upstream] + N aliases
// ───────────────────────────────────────────────────────────────────────────

describe('renderShimConfig — multi-class same target', () => {
  const out = renderShimConfig(FIXED_KEY, [
    assign('mail', s3Target),
    assign('system', s3Target),
    assign('tenant', s3Target),
  ]);

  it('classesTxt has one line per class in alphabetical order', () => {
    expect(out.classesTxt.split('\n').filter(Boolean)).toEqual([
      'mail',
      'system',
      'tenant',
    ]);
  });

  it('renders exactly ONE upstream section (target dedup)', () => {
    const sections = out.rcloneConf.match(/^\[upstream_/gm) ?? [];
    expect(sections).toHaveLength(1);
  });

  it('combined section has 3 class aliases all pointing at same upstream', () => {
    const m = out.rcloneConf.match(/^upstreams = (.+)$/m);
    expect(m).not.toBeNull();
    const pairs = m![1].split(' ');
    expect(pairs).toHaveLength(3);
    expect(pairs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^mail=upstream_[0-9a-f]{8}:k8s-staging\/mail$/),
        expect.stringMatching(/^system=upstream_[0-9a-f]{8}:k8s-staging\/system$/),
        expect.stringMatching(/^tenant=upstream_[0-9a-f]{8}:k8s-staging\/tenant$/),
      ]),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Multi-class DIFFERENT targets — N upstreams + N aliases
// ───────────────────────────────────────────────────────────────────────────

describe('renderShimConfig — multi-class mixed-protocol targets (R-X20 lift)', () => {
  // The R-X19-era "All shim classes must share one upstream target"
  // invariant is GONE. Each class can point at a distinct target with
  // a distinct protocol.
  const out = renderShimConfig(FIXED_KEY, [
    assign('system', s3Target),
    assign('tenant', sftpTarget),
    assign('mail', cifsTarget),
  ]);

  it('does NOT throw on mixed-target assignment', () => {
    expect(out.classesTxt).toBe('mail\nsystem\ntenant\n');
  });

  it('renders 3 distinct upstream sections', () => {
    const sections = out.rcloneConf.match(/^\[upstream_[0-9a-f]{8}\]$/gm) ?? [];
    expect(sections).toHaveLength(3);
  });

  it('one section per target type (s3, sftp, smb)', () => {
    expect((out.rcloneConf.match(/^type = s3$/gm) ?? [])).toHaveLength(1);
    expect((out.rcloneConf.match(/^type = sftp$/gm) ?? [])).toHaveLength(1);
    expect((out.rcloneConf.match(/^type = smb$/gm) ?? [])).toHaveLength(1);
  });

  it('combined aliases each class to its own upstream + class suffix', () => {
    const m = out.rcloneConf.match(/^upstreams = (.+)$/m);
    expect(m).not.toBeNull();
    const pairs = m![1].split(' ');
    // s3 target → system class
    expect(pairs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^system=upstream_[0-9a-f]{8}:k8s-staging\/system$/),
        expect.stringMatching(/^tenant=upstream_[0-9a-f]{8}:backup\/tenant$/),
        expect.stringMatching(/^mail=upstream_[0-9a-f]{8}:u335448\/backup\/mail$/),
      ]),
    );
  });

  it('posixMounts reports both POSIX-backed targets (sftp+cifs)', () => {
    expect(out.posixMounts.map((m) => m.storageType).sort()).toEqual(['cifs', 'sftp']);
  });

  it('sshKeyMaterializations is empty (password auth on sftp target)', () => {
    expect(out.sshKeyMaterializations).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Determinism + computeInputHash
// ───────────────────────────────────────────────────────────────────────────

describe('renderShimConfig — determinism', () => {
  it('same inputs → byte-identical classesTxt + rcloneConf (modulo obscure IV)', () => {
    const a = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);
    const b = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);
    expect(a.classesTxt).toBe(b.classesTxt);
    // S3 doesn't obscure → conf is byte-identical
    expect(a.rcloneConf).toBe(b.rcloneConf);
    expect(a.upstreamEnv).toBe(b.upstreamEnv);
  });

  it('SFTP password obscured outputs differ by IV but inputHash matches', () => {
    const a = renderShimConfig(FIXED_KEY, [assign('tenant', sftpTarget)]);
    const b = renderShimConfig(FIXED_KEY, [assign('tenant', sftpTarget)]);
    // rclone obscure uses fresh random IV per call
    expect(a.rcloneConf).not.toBe(b.rcloneConf);
    // But the computeInputHash is over INPUTS not OUTPUTS
    expect(computeInputHash(FIXED_KEY, [assign('tenant', sftpTarget)])).toBe(
      computeInputHash(FIXED_KEY, [assign('tenant', sftpTarget)]),
    );
  });
});

describe('computeInputHash', () => {
  it('is stable across renders', () => {
    const a = computeInputHash(FIXED_KEY, [assign('system', s3Target)]);
    const b = computeInputHash(FIXED_KEY, [assign('system', s3Target)]);
    expect(a).toBe(b);
  });

  it('changes when the key changes', () => {
    const otherKey = Buffer.alloc(32, 0xff);
    expect(computeInputHash(FIXED_KEY, [assign('system', s3Target)])).not.toBe(
      computeInputHash(otherKey, [assign('system', s3Target)]),
    );
  });

  it('changes when a credential changes', () => {
    const mutated: BackupTargetConfig = { ...s3Target, s3AccessKey: 'AKIA_DIFFERENT' };
    expect(computeInputHash(FIXED_KEY, [assign('system', s3Target)])).not.toBe(
      computeInputHash(FIXED_KEY, [assign('system', mutated)]),
    );
  });

  it('changes when s3UsePathStyle toggles', () => {
    const a: BackupTargetConfig = { ...s3Target, s3UsePathStyle: true };
    const b: BackupTargetConfig = { ...s3Target, s3UsePathStyle: false };
    expect(computeInputHash(FIXED_KEY, [assign('system', a)])).not.toBe(
      computeInputHash(FIXED_KEY, [assign('system', b)]),
    );
  });

  it('treats s3UsePathStyle=undefined and =true identically (legacy compat)', () => {
    const legacy: BackupTargetConfig = { ...s3Target };
    const explicit: BackupTargetConfig = { ...s3Target, s3UsePathStyle: true };
    expect(computeInputHash(FIXED_KEY, [assign('system', legacy)])).toBe(
      computeInputHash(FIXED_KEY, [assign('system', explicit)]),
    );
  });

  it('is insensitive to assignment order', () => {
    const ordered = [
      assign('system', s3Target),
      assign('tenant', s3Target),
      assign('mail', s3Target),
    ];
    const reordered = [
      assign('mail', s3Target),
      assign('tenant', s3Target),
      assign('system', s3Target),
    ];
    expect(computeInputHash(FIXED_KEY, ordered)).toBe(
      computeInputHash(FIXED_KEY, reordered),
    );
  });
});
