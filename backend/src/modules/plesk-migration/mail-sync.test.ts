import { describe, it, expect } from 'vitest';
import { parseMailResults, quotaMbFor, buildMailSyncJob, isValidEmailAddress } from './mail-sync.js';

describe('isValidEmailAddress (remote-shell + path guard)', () => {
  it('accepts real addresses', () => {
    expect(isValidEmailAddress('reception@acme.example')).toBe(true);
    expect(isValidEmailAddress('john.doe+tag@sub.acme.co')).toBe(true);
  });
  it('rejects injection / malformed addresses', () => {
    expect(isValidEmailAddress("x'; rm -rf /@acme.example")).toBe(false);
    expect(isValidEmailAddress('a b@acme.example')).toBe(false);
    expect(isValidEmailAddress('no-at-sign')).toBe(false);
    expect(isValidEmailAddress('a@nodot')).toBe(false);
  });
});

describe('parseMailResults', () => {
  it('parses ok/fail MAILRESULT lines between the sentinels', () => {
    const log = [
      'noise',
      '===MAILSYNC-BEGIN===',
      'MAILRESULT a@acme.example ok imported=120 skipped=3 failed=0',
      'MAILRESULT b@acme.example fail imap-restore-exit-1-AUTHENTICATIONFAILED',
      '===MAILSYNC-END===',
    ].join('\n');
    const r = parseMailResults(log);
    expect(r.get('a@acme.example')).toEqual({ ok: true, message: 'imported=120 skipped=3 failed=0' });
    expect(r.get('b@acme.example')?.ok).toBe(false);
    expect(r.size).toBe(2);
  });
  it('still parses when the END sentinel is missing (job OOM-killed mid-output)', () => {
    const r = parseMailResults('===MAILSYNC-BEGIN===\nMAILRESULT x@acme.example ok imported=5');
    expect(r.get('x@acme.example')?.ok).toBe(true);
  });
});

describe('quotaMbFor', () => {
  it('uses the Plesk quota when positive, else a sane default', () => {
    expect(quotaMbFor({ address: 'a@x', quotaMb: 1024, passwordType: 'sym' })).toBe(1024);
    expect(quotaMbFor({ address: 'a@x', quotaMb: null, passwordType: null })).toBe(2048); // unlimited on Plesk
    expect(quotaMbFor({ address: 'a@x', quotaMb: 0, passwordType: null })).toBe(2048);
  });
});

describe('buildMailSyncJob (IMAP reuse + hardening)', () => {
  const source = {
    id: 'srcabcde', name: 's', hostname: 'plesk.example.test', sshPort: 22, sshUser: 'root',
    sshKeyEncrypted: 'x', pleskVersion: null, passwordStorage: null, lastDiscoveredAt: null,
    status: 'discovered', createdBy: null, createdAt: new Date(),
  } as Parameters<typeof buildMailSyncJob>[0]['source'];

  it('runs in the mail namespace with the optimized IMAP engine + master-user proxy', () => {
    const job = buildMailSyncJob({ jobName: 'j', secretName: 'sec', source, masterUser: 'master@apex.example', addresses: ['a@acme.example', 'b@acme.example'] }) as any;
    expect(job.metadata.namespace).toBe('mail');
    const c = job.spec.template.spec.containers[0];
    expect(c.image).toContain('mail-backup-tools'); // the image that ships imap-restore.py
    expect(c.command).toEqual(['bash', '/usr/local/bin/plesk-mail-sync.sh']);
    const env = Object.fromEntries(c.env.filter((e: { value?: string }) => e.value !== undefined).map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(env.IMAP_HOST).toContain('stalwart-mail');
    expect(env.IMAP_PORT).toBe('993');
    expect(env.STALWART_MASTER_USER).toBe('master@apex.example');
    expect(env.MAILBOXES).toBe('a@acme.example b@acme.example');
    expect(Number(env.WORKERS)).toBeGreaterThan(1); // multi-worker
    // master password comes from the mail-secrets Secret (never plaintext)
    const pw = c.env.find((e: { name: string }) => e.name === 'STALWART_MASTER_PASSWORD');
    expect(pw.valueFrom.secretKeyRef).toMatchObject({ name: 'mail-secrets', key: 'STALWART_MASTER_PASSWORD' });
    expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(job.spec.backoffLimit).toBe(0);
  });
});
