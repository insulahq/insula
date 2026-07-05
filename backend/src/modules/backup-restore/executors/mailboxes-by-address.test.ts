/**
 * Unit tests for the restic-native mailboxes-by-address restore executor
 * — the Job spec builder. The end-to-end restore is covered by the mail
 * DR / restore integration harness (E2E).
 *
 * The mailboxes capture (ADR-047) writes ONE whole-tenant restic stream
 * (stdin-filename `maildir.tar`) per bundle — there is no per-address
 * `<addr>.mbox.tar.gz` artifact. The restore Job therefore runs `restic
 * restore <snap>` once, extracts the shared Maildir tree, then loops the
 * target addresses running jmap-restore.py per address off the shared
 * extraction root.
 */

import { describe, it, expect } from 'vitest';
import { buildMailboxesByAddressJobSpec } from './mailboxes-by-address.js';

describe('buildMailboxesByAddressJobSpec', () => {
  const baseInput = {
    jobName: 'rs-mbox-item-1',
    mailNamespace: 'mail',
    tenantId: 'tenant-acme',
    cartId: 'rstr-1',
    itemId: 'item-1',
    toolsImage: 'ghcr.io/insulahq/insula/tenant-backup-tools:latest',
    jmapEndpoint: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    stalwartMasterUser: 'master@master.local',
    masterSecretName: 'mail-secrets',
    masterSecretKey: 'STALWART_MASTER_PASSWORD',
    mode: 'merge-skip-duplicates' as const,
    credsSecretName: 'rs-mbox-creds-item1',
    snapshotId: 'a'.repeat(64),
    addresses: ['a@example.com', 'b@example.com'],
    workers: 16,
  };

  it('runs in the mail namespace', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as { metadata: { namespace: string } };
    expect(spec.metadata.namespace).toBe('mail');
  });

  it('labels with platform.io/component=restore-files (matches tightened NetworkPolicy)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('restore-files');
    expect(spec.metadata.labels['platform.io/sub-component']).toBe('restore-mailboxes');
    expect(spec.metadata.labels['platform.io/restore-cart']).toBe('rstr-1');
  });

  it('rejects shell-special and URL-special chars in addresses (defence-in-depth)', () => {
    expect(() => buildMailboxesByAddressJobSpec({
      ...baseInput,
      addresses: ['a;rm -rf /@example.com'],
    })).toThrow(/invalid address/);
    expect(() => buildMailboxesByAddressJobSpec({
      ...baseInput,
      addresses: ['a@example.com?attack'],
    })).toThrow(/invalid address/);
  });

  it('rejects an empty address list', () => {
    expect(() => buildMailboxesByAddressJobSpec({ ...baseInput, addresses: [] }))
      .toThrow(/no addresses/);
  });

  it('rejects unsafe jmapEndpoint', () => {
    expect(() => buildMailboxesByAddressJobSpec({
      ...baseInput,
      jmapEndpoint: 'http://example.com$(curl evil)',
    })).toThrow(/invalid jmapEndpoint/);
    expect(() => buildMailboxesByAddressJobSpec({
      ...baseInput,
      jmapEndpoint: 'ftp://example.com',
    })).toThrow(/invalid jmapEndpoint/);
  });

  it('rejects out-of-range worker counts', () => {
    expect(() => buildMailboxesByAddressJobSpec({ ...baseInput, workers: 0 }))
      .toThrow(/invalid workers/);
    expect(() => buildMailboxesByAddressJobSpec({ ...baseInput, workers: 65 }))
      .toThrow(/invalid workers/);
  });

  it('rejects a malformed snapshot id', () => {
    expect(() => buildMailboxesByAddressJobSpec({ ...baseInput, snapshotId: 'not-hex' }))
      .toThrow(/invalid snapshotId/);
    expect(() => buildMailboxesByAddressJobSpec({ ...baseInput, snapshotId: '' }))
      .toThrow(/invalid snapshotId/);
  });

  it('embeds addresses in the script via POSIX case dispatch (no MAILBOX_ADDR_* env)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }>; command: string[] }> } } };
    };
    const env = spec.spec.template.spec.containers[0]!.env;
    // No per-address env vars — addresses are baked into the case statement.
    expect(env.find((e) => e.name?.startsWith('MAILBOX_ADDR_'))).toBeUndefined();
    expect(env.find((e) => e.name?.startsWith('MAILBOX_TOKEN_'))).toBeUndefined();
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // case "$i" dispatch contains the literal address (no download token).
    expect(cmd).toContain('0) ADDR="a@example.com"');
    expect(cmd).toContain('1) ADDR="b@example.com"');
  });

  it('mounts STALWART_MASTER_PASSWORD from the mail-secrets Secret (master-user proxy auth)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }> }> } } };
    };
    const adminEnv = spec.spec.template.spec.containers[0]!.env.find((e) => e.name === 'STALWART_MASTER_PASSWORD');
    expect(adminEnv?.valueFrom?.secretKeyRef?.name).toBe('mail-secrets');
    expect(adminEnv?.valueFrom?.secretKeyRef?.key).toBe('STALWART_MASTER_PASSWORD');
  });

  it('mounts the restic creds Secret read-only at /var/run/restic-creds (mode 0400)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: {
        containers: Array<{ volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
        volumes: Array<{ name: string; secret?: { secretName: string; defaultMode?: number } }>;
      } } };
    };
    const mount = spec.spec.template.spec.containers[0]!.volumeMounts.find((m) => m.name === 'restic-creds');
    expect(mount?.mountPath).toBe('/var/run/restic-creds');
    expect(mount?.readOnly).toBe(true);
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'restic-creds');
    expect(vol?.secret?.secretName).toBe('rs-mbox-creds-item1');
    expect(vol?.secret?.defaultMode).toBe(0o400);
  });

  it('script runs restic restore, extracts maildir.tar, then jmap-restore.py per address', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[]; image: string }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(spec.spec.template.spec.containers[0]!.image).toMatch(/tenant-backup-tools/);
    // One restic restore of the whole-tenant snapshot, then tar-extract.
    expect(cmd).toContain(`restic -r "$REPO" restore ${'a'.repeat(64)} --target /tmp/restic-out`);
    expect(cmd).toContain('--no-lock');
    expect(cmd).toContain('tar xf "$TARBALL" -C /tmp/maildir-all');
    // restic creds come from the mounted Secret, never argv.
    expect(cmd).toContain('export RESTIC_PASSWORD="$(cat /var/run/restic-creds/restic_password)"');
    expect(cmd).toContain('REPO="$(cat /var/run/restic-creds/repo_uri)"');
    // Per-address JMAP restore off the SHARED extraction root.
    expect(cmd).toContain('/usr/local/bin/jmap-restore.py');
    expect(cmd).toContain('--maildir-root /tmp/maildir-all');
    expect(cmd).toContain('--source-address "$ADDR"');
    // No legacy per-address download path, no IMAP-only tooling.
    expect(cmd).not.toContain('curl');
    expect(cmd).not.toContain('.mbox.tar.gz');
    expect(cmd).not.toContain('stalwart-cli');
    expect(cmd).not.toContain('restore-mailbox.py');
    // jmap-restore.py authenticates via master-user proxy.
    expect(cmd).toContain('--master-user "master@master.local"');
    expect(cmd).toContain('--auth-pass-env STALWART_MASTER_PASSWORD');
  });

  it('drives the aux restore off /tmp/maildir-all/$ADDR/.aux', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('/usr/local/bin/jmap-aux-restore.py');
    expect(cmd).toContain('[ -d "/tmp/maildir-all/$ADDR/.aux" ]');
  });

  it('uses imap-restore.py when engine=imap (shared extraction root)', () => {
    const spec = buildMailboxesByAddressJobSpec({ ...baseInput, engine: 'imap' }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('/usr/local/bin/imap-restore.py');
    expect(cmd).toContain('--imap-host stalwart-mail.mail.svc.cluster.local');
    expect(cmd).toContain('--maildir-root /tmp/maildir-all');
    expect(cmd).not.toContain('jmap-restore.py');
  });

  it('embeds the chosen mode and worker count in the script', () => {
    const spec1 = buildMailboxesByAddressJobSpec({ ...baseInput, mode: 'merge-skip-duplicates' }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    expect(spec1.spec.template.spec.containers[0]!.command.join(' ')).toContain('MODE=merge-skip-duplicates');

    const spec2 = buildMailboxesByAddressJobSpec({ ...baseInput, mode: 'merge-overwrite' }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    expect(spec2.spec.template.spec.containers[0]!.command.join(' ')).toContain('MODE=merge-overwrite');

    const spec3 = buildMailboxesByAddressJobSpec({ ...baseInput, mode: 'replace' }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    expect(spec3.spec.template.spec.containers[0]!.command.join(' ')).toContain('MODE=replace');

    const spec4 = buildMailboxesByAddressJobSpec({ ...baseInput, workers: 24 }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    expect(spec4.spec.template.spec.containers[0]!.command.join(' ')).toContain('WORKERS=24');
  });
});
