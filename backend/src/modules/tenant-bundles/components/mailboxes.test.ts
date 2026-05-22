/**
 * Unit tests for the Phase 2 JMAP-driven mailboxes-component.
 *
 * Pins the spec shape + JMAP_DONE/MAILBOXES_DONE log parsing. The
 * real network flow is exercised by scripts/integration-tenant-bundles-jmap.sh.
 */

import { describe, it, expect } from 'vitest';
import { buildMailboxesComponentJobSpec, parseMailboxesDone } from './mailboxes.js';

describe('buildMailboxesComponentJobSpec', () => {
  const baseInput = {
    jobName: 'bk-mbox-bkp-test',
    mailNamespace: 'mail',
    tenantId: 'abc',
    backupId: 'bkp-test',
    toolsImage: 'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest',
    jmapEndpoint: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    stalwartMasterUser: 'master@master.local',
    masterSecretName: 'roundcube-secrets',
    masterSecretKey: 'STALWART_MASTER_PASSWORD',
    uploadUrlNoToken: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-test/components/mailboxes/restic-stream?filename=maildir.tar',
    uploadTokenSecretName: 'bk-mbox-token-bkp-test',
    stateSecretName: 'bk-mbox-state-bkp-test',
    addresses: [
      { address: 'user1@example.com', stateIn: null },
      { address: 'user2@example.com', stateIn: '"abc123"' },
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

  it('does NOT mount the JMAP state Secret (COMPLETE-only since 2026-05-22)', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: {
        template: {
          spec: {
            containers: Array<{ env: Array<{ name: string; value?: string }>; volumeMounts: Array<{ name: string }> }>;
            volumes: Array<{ name: string }>;
          };
        };
      };
    };
    const container = spec.spec.template.spec.containers[0]!;
    // No MBX_STATE_* env vars — state tokens never went through shell.
    expect(container.env.find((e) => e.name?.startsWith('MBX_STATE_'))).toBeUndefined();
    // jmap-state mount removed: bundles are COMPLETE-only, no state.
    expect(container.volumeMounts.find((m) => m.name === 'jmap-state')).toBeUndefined();
    expect(spec.spec.template.spec.volumes.find((v) => v.name === 'jmap-state')).toBeUndefined();
  });

  it('mounts the upload token from a Secret (NOT etcd-visible argv)', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { volumes: Array<{ name: string; secret?: { secretName: string; defaultMode: number } }> } } };
    };
    const tokenVol = spec.spec.template.spec.volumes.find((v) => v.name === 'upload-token');
    expect(tokenVol?.secret?.secretName).toBe('bk-mbox-token-bkp-test');
    expect(tokenVol?.secret?.defaultMode).toBe(0o400);
  });

  it('mounts the master password env from the roundcube-secrets Secret', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }> }> } } };
    };
    const env = spec.spec.template.spec.containers[0]!.env;
    const pw = env.find((e) => e.name === 'STALWART_MASTER_PASSWORD');
    expect(pw?.valueFrom?.secretKeyRef?.name).toBe('roundcube-secrets');
    expect(pw?.valueFrom?.secretKeyRef?.key).toBe('STALWART_MASTER_PASSWORD');
  });

  it('script invokes jmap-sync.py with the configured endpoint + master user', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const script = spec.spec.template.spec.containers[0]!.command[2]!;
    expect(script).toContain('/usr/local/bin/jmap-sync.py');
    // The URL is shQuote'd — `://` characters are outside the safe
    // regex so it gets single-quoted; the colon and slash variants
    // both round-trip through the quoting helper.
    expect(script).toMatch(/--endpoint ['"]?http:\/\/stalwart-mgmt[.\w:-]+['"]?/);
    expect(script).toContain('master@master.local');
    expect(script).toContain('--auth-pass-env STALWART_MASTER_PASSWORD');
  });

  it('uses a case-statement loop (NOT eval) to dispatch per-address ADDR', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const script = spec.spec.template.spec.containers[0]!.command[2]!;
    // Defence: no `eval echo ...` should remain after the
    // reviewer-flagged shell-injection fix.
    expect(script).not.toMatch(/eval\s+echo/);
    expect(script).toContain('case "$i" in');
    expect(script).toContain('0) ADDR=');
    expect(script).toContain('1) ADDR=');
  });

  it('script streams tar via curl --upload-file to the restic-stream endpoint', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const script = spec.spec.template.spec.containers[0]!.command[2]!;
    expect(script).toContain('tar cf - .');
    expect(script).toContain('curl --fail-with-body');
    expect(script).toContain('restic-stream');
    expect(script).toContain('Content-Type: application/x-tar');
  });

  it('emits MAILBOXES_DONE bundleId=... snapshot=... line for orchestrator parsing', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const script = spec.spec.template.spec.containers[0]!.command[2]!;
    expect(script).toContain('MAILBOXES_DONE bundleId=bkp-test snapshot=');
  });

  it('rejects an address with shell metacharacters (defence-in-depth)', () => {
    const bad = { ...baseInput, addresses: [{ address: '"; rm -rf / ;@x', stateIn: null }] };
    expect(() => buildMailboxesComponentJobSpec(bad)).toThrow(/invalid address/i);
  });

  it('rejects a JMAP endpoint that is not http(s)://host[:port]', () => {
    const bad = { ...baseInput, jmapEndpoint: 'file:///etc/passwd' };
    expect(() => buildMailboxesComponentJobSpec(bad)).toThrow(/jmapEndpoint/i);
  });

  it('rejects a stalwartMasterUser with shell metacharacters', () => {
    const bad = { ...baseInput, stalwartMasterUser: 'master@example.com; whoami' };
    expect(() => buildMailboxesComponentJobSpec(bad)).toThrow(/stalwartMasterUser/i);
  });
});

describe('parseMailboxesDone', () => {
  it('parses one JMAP_DONE + one MAILBOXES_DONE line into newStates + sizeBytes', () => {
    const log = [
      'Capturing mailbox user1@example.com (#0 of 2)...',
      'JMAP_DONE bundleId=bkp-test address=user1@example.com summary={"address":"user1@example.com","fetched":12,"skipped":0,"newState":"s1","fullPull":false}',
      'JMAP_DONE bundleId=bkp-test address=user2@example.com summary={"address":"user2@example.com","fetched":0,"skipped":1,"newState":"s2","fullPull":true}',
      'Streaming Maildir tarball to platform-api restic-stream...',
      'MAILBOXES_DONE bundleId=bkp-test snapshot=' + 'a'.repeat(64) + ' sizeBytes=4096',
    ].join('\n');

    const r = parseMailboxesDone(log, 'bkp-test');
    expect(r.sizeBytes).toBe(4096);
    expect(r.newStates).toHaveLength(2);
    expect(r.newStates[0]).toMatchObject({ address: 'user1@example.com', newState: 's1', fullPull: false, fetched: 12 });
    expect(r.newStates[1]).toMatchObject({ address: 'user2@example.com', newState: 's2', fullPull: true, skipped: 1 });
  });

  it('skips JMAP_DONE lines for a different bundleId (defends against stale Job-log reuse)', () => {
    const log = [
      'JMAP_DONE bundleId=other-bundle address=x@y.com summary={"address":"x@y.com","fetched":1,"skipped":0,"newState":"s","fullPull":false}',
      'JMAP_DONE bundleId=bkp-test address=mine@y.com summary={"address":"mine@y.com","fetched":2,"skipped":0,"newState":"t","fullPull":false}',
    ].join('\n');
    const r = parseMailboxesDone(log, 'bkp-test');
    expect(r.newStates).toHaveLength(1);
    expect(r.newStates[0]?.address).toBe('mine@y.com');
  });

  it('ignores malformed summary JSON (no row added; orchestrator re-pulls next run)', () => {
    const log = 'JMAP_DONE bundleId=bkp-test address=u@x.com summary={NOT VALID JSON}';
    const r = parseMailboxesDone(log, 'bkp-test');
    expect(r.newStates).toHaveLength(0);
  });

  it('returns zero size when MAILBOXES_DONE is absent', () => {
    const log = 'JMAP_DONE bundleId=bkp-test address=x@y.com summary={"address":"x@y.com","fetched":1,"skipped":0,"newState":"s","fullPull":false}';
    const r = parseMailboxesDone(log, 'bkp-test');
    expect(r.sizeBytes).toBe(0);
    expect(r.newStates).toHaveLength(1);
  });

  it('accepts IMAP_DONE lines with no newState/fullPull (engine=imap, COMPLETE only)', () => {
    const log = [
      'IMAP_DONE bundleId=bkp-test address=u@x.com summary={"address":"u@x.com","fetched":42,"skipped":0,"folders":3,"elapsedSeconds":1.2,"engine":"imap"}',
      'MAILBOXES_DONE bundleId=bkp-test snapshot=' + 'a'.repeat(64) + ' sizeBytes=999',
    ].join('\n');
    const r = parseMailboxesDone(log, 'bkp-test');
    expect(r.newStates).toHaveLength(1);
    expect(r.newStates[0]?.address).toBe('u@x.com');
    expect(r.newStates[0]?.fetched).toBe(42);
    // IMAP path synthesizes empty newState + fullPull=true (no incremental).
    expect(r.newStates[0]?.newState).toBe('');
    expect(r.newStates[0]?.fullPull).toBe(true);
    expect(r.sizeBytes).toBe(999);
  });
});

describe('buildMailboxesComponentJobSpec — engine=imap', () => {
  const base = {
    jobName: 'bk-mbox-imap',
    mailNamespace: 'mail',
    tenantId: 'abc',
    backupId: 'bkp-imap',
    toolsImage: 'ghcr.io/x/mail-backup-tools:latest',
    engine: 'imap' as const,
    jmapEndpoint: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    imapHost: 'stalwart-mail.mail.svc.cluster.local',
    imapPort: 993,
    stalwartMasterUser: 'master@master.local',
    masterSecretName: 'roundcube-secrets',
    masterSecretKey: 'STALWART_MASTER_PASSWORD',
    uploadUrlNoToken: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-imap/components/mailboxes/restic-stream?filename=maildir.tar',
    uploadTokenSecretName: 'bk-mbox-token-bkp-imap',
    stateSecretName: 'bk-mbox-state-bkp-imap', // ignored when engine='imap'
    addresses: [
      { address: 'user1@example.com', stateIn: null },
    ],
  };

  it('script invokes imap-sync.py (not jmap-sync.py)', () => {
    const spec = buildMailboxesComponentJobSpec(base);
    const cmd = (spec.spec as { template: { spec: { containers: Array<{ command: string[] }> } } })
      .template.spec.containers[0]!.command;
    const script = cmd[2]!;
    expect(script).toContain('/usr/local/bin/imap-sync.py');
    expect(script).toContain('--imap-host stalwart-mail.mail.svc.cluster.local');
    expect(script).toContain('--imap-port 993');
    expect(script).not.toContain('jmap-sync.py');
    expect(script).not.toContain('--state-in');
    expect(script).not.toContain('--state-out');
  });

  it('emits IMAP_DONE (not JMAP_DONE) per address so parseMailboxesDone picks up IMAP summaries', () => {
    const spec = buildMailboxesComponentJobSpec(base);
    const cmd = (spec.spec as { template: { spec: { containers: Array<{ command: string[] }> } } })
      .template.spec.containers[0]!.command;
    expect(cmd[2]).toContain('IMAP_DONE bundleId=bkp-imap');
    expect(cmd[2]).not.toContain('JMAP_DONE');
  });

  it('omits the jmap-state Secret mount + volume when engine=imap', () => {
    const spec = buildMailboxesComponentJobSpec(base);
    const template = (spec.spec as { template: { spec: { containers: Array<{ volumeMounts: Array<{ name: string }> }>; volumes: Array<{ name: string }> } } }).template.spec;
    const mountNames = template.containers[0]!.volumeMounts.map((m) => m.name);
    const volumeNames = template.volumes.map((v) => v.name);
    expect(mountNames).not.toContain('jmap-state');
    expect(volumeNames).not.toContain('jmap-state');
    // But upload-token + scratch are still there.
    expect(mountNames).toContain('upload-token');
    expect(mountNames).toContain('scratch');
  });

  it('rejects invalid imapHost', () => {
    expect(() => buildMailboxesComponentJobSpec({ ...base, imapHost: 'bad host with spaces' }))
      .toThrow(/invalid imapHost/);
  });

  it('rejects invalid imapPort', () => {
    expect(() => buildMailboxesComponentJobSpec({ ...base, imapPort: 99999 }))
      .toThrow(/invalid imapPort/);
  });

  it('engine defaults to jmap when not specified — JMAP path still works (legacy compat)', () => {
    const { engine: _engine, ...withoutEngine } = base;
    const spec = buildMailboxesComponentJobSpec(withoutEngine);
    const template = (spec.spec as { template: { spec: { containers: Array<{ command: string[]; volumeMounts: Array<{ name: string }> }> } } }).template.spec;
    expect(template.containers[0]!.command[2]).toContain('jmap-sync.py');
    expect(template.containers[0]!.command[2]).not.toContain('imap-sync.py');
    // 2026-05-22: state mount removed from JMAP path too (COMPLETE-only).
    const mountNames = template.containers[0]!.volumeMounts.map((m) => m.name);
    expect(mountNames).not.toContain('jmap-state');
    // --state-in / --state-out args no longer passed.
    expect(template.containers[0]!.command[2]).not.toContain('--state-in');
    expect(template.containers[0]!.command[2]).not.toContain('--state-out');
  });
});
