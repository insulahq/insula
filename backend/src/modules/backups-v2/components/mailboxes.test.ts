import { describe, it, expect } from 'vitest';
import { buildMailboxesComponentJobSpec } from './mailboxes.js';

describe('buildMailboxesComponentJobSpec', () => {
  const baseInput = {
    jobName: 'bk-mbox-bkp-test',
    mailNamespace: 'mail',
    clientId: 'abc',
    backupId: 'bkp-test',
    jobImage: 'alpine:3.20',
    stalwartMgmtUrl: 'http://stalwart-mail-v016.mail.svc:8080',
    uploadBase: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-test/components/mailboxes',
    uploads: [
      { address: 'user1@example.com', token: '1.deadbeef' },
      { address: 'user2@example.com', token: '2.cafebabe' },
    ],
  };

  it('runs in the mail namespace', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as { metadata: { namespace: string } };
    expect(spec.metadata.namespace).toBe('mail');
  });

  it('carries platform.io/component=backup-files so the existing NetworkPolicy applies', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('backup-files');
    expect(spec.metadata.labels['platform.io/sub-component']).toBe('backup-mailboxes');
  });

  it('passes per-mailbox tokens via env vars (not embedded in script body)', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }>; command: string[] }> } } };
    };
    const env = spec.spec.template.spec.containers[0]!.env;
    const envNames = env.map((e) => e.name).sort();
    expect(envNames).toContain('MAILBOX_TOKEN_0');
    expect(envNames).toContain('MAILBOX_TOKEN_1');
    expect(envNames).toContain('MAILBOX_ADDR_0');
    expect(envNames).toContain('MAILBOX_ADDR_1');
    expect(envNames).toContain('STALWART_RECOVERY_ADMIN');
    // Tokens are NOT in the rendered script body (only the env var name reference).
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toContain('1.deadbeef');
    expect(cmd).not.toContain('2.cafebabe');
  });

  it('mounts STALWART_RECOVERY_ADMIN from the stalwart-admin-creds Secret', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }> }> } } };
    };
    const cred = spec.spec.template.spec.containers[0]!.env.find((e) => e.name === 'STALWART_RECOVERY_ADMIN');
    expect(cred?.valueFrom?.secretKeyRef?.name).toBe('stalwart-admin-creds');
    expect(cred?.valueFrom?.secretKeyRef?.key).toBe('recoveryAdmin');
  });

  it('uses stalwart-cli account export (upstream-documented path) + curl --upload-file to platform-api', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // stalwart-cli is on PATH in the Stalwart base image and is the
    // forward-compatible export path (it adapts to whatever HTTP API
    // shape the server speaks).
    expect(cmd).toContain('stalwart-cli');
    expect(cmd).toContain('account export');
    // Streaming upload from disk — same OOM-defence pattern as files.
    expect(cmd).toContain('--upload-file');
    expect(cmd).toContain(baseInput.uploadBase);
    // The stalwart-cli step writes a per-address tarball; we then
    // upload + immediately rm to keep emptyDir bounded.
    expect(cmd).toContain('rm -f "/tmp/mboxes/$ADDR.tar.gz"');
  });

  it('rejects unsafe addresses (defence against shell injection from forged DB rows)', () => {
    expect(() => buildMailboxesComponentJobSpec({
      ...baseInput,
      uploads: [{ address: 'evil$(rm -rf /)@x.com', token: 't' }],
    })).toThrow(/invalid address/);
    expect(() => buildMailboxesComponentJobSpec({
      ...baseInput,
      uploads: [{ address: 'a@b.com; rm -rf /', token: 't' }],
    })).toThrow(/invalid address/);
  });

  it('sets backoffLimit=0 (fail loud)', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as { spec: { backoffLimit: number } };
    expect(spec.spec.backoffLimit).toBe(0);
  });
});
