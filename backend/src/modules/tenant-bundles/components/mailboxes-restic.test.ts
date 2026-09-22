import { describe, it, expect } from 'vitest';
import {
  addressDirName,
  buildMailboxesCaptureScript,
  buildMailboxesResticJobSpec,
  parseMailboxDoneLines,
  MAILBOX_CAPTURE_ROOT,
  CREDS_MOUNT_PATH,
} from './mailboxes-restic.js';

const BUNDLE = 'bkp-1111';
const TENANT = '86ecffb5-66aa-49fc-b10a-4671fdd7dd94';

function script(addresses: string[] = ['a@example.test', 'b@example.test']) {
  return buildMailboxesCaptureScript({
    addresses,
    tenantId: TENANT,
    backupId: BUNDLE,
    engine: 'imap',
    jmapEndpoint: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    imapHost: 'stalwart-mail.mail.svc.cluster.local',
    imapPort: 993,
    stalwartMasterUser: 'master@example.test',
    tags: ['bundle=bkp-1111', 'component=mailboxes'],
  });
}

describe('addressDirName', () => {
  it('mirrors the python sanitiser for characters it keeps', () => {
    expect(addressDirName('user.name-1@example.test')).toBe('user.name-1@example.test');
  });

  it('rewrites the plus that isSafeAddress admits but the sanitiser does not', () => {
    // If these two ever disagree the Job backs up a path that does not exist.
    expect(addressDirName('user+tag@example.test')).toBe('user_tag@example.test');
  });
});

describe('buildMailboxesCaptureScript', () => {
  it('pins --host to the tenant so a parent snapshot is matched across Jobs', () => {
    // Without this restic uses the POD hostname, which differs every run, so
    // no parent is found and every file is re-read even though none is stored.
    expect(script()).toContain(`--host ${TENANT}`);
  });

  it('ignores inode and ctime, which a rebuilt tree always changes', () => {
    const s = script();
    expect(s).toContain('--ignore-inode');
    expect(s).toContain('--ignore-ctime');
  });

  it('compresses mail (the whole point of per-component compression)', () => {
    expect(script()).toContain('--compression auto');
  });

  it('snapshots each address separately and frees its tree before the next', () => {
    const s = script();
    expect(s).toContain('restic -r "$REPO" backup "$CAPTURE_ROOT/$ADDRDIR"');
    // Peak scratch is bounded by the largest mailbox only if this runs.
    expect(s).toContain('rm -rf "$CAPTURE_ROOT/$ADDRDIR"');
    expect(s).toContain('--tag "address=$ADDR"');
    expect(s).toContain('rawBytes=');
  });

  it('dispatches addresses by index rather than interpolating into a loop', () => {
    const s = script(['a@example.test', 'b@example.test', 'c@example.test']);
    expect(s).toContain('0) ADDR=a@example.test;');
    expect(s).toContain('2) ADDR=c@example.test;');
    expect(s).toContain('COUNT=3');
    expect(s).toContain('*) echo "ERROR: invalid index $i"; exit 1 ;;');
  });

  it('never streams a tarball to platform-api', () => {
    const s = script();
    expect(s).not.toContain('tar cf -');
    expect(s).not.toContain('--upload-file');
    expect(s).not.toContain('restic-stream');
  });

  it('treats a restic exit 3 as a warning and anything else as fatal', () => {
    const s = script();
    expect(s).toContain('[ "$RC" = "3" ]');
    expect(s).toContain('ERROR: restic backup failed for $ADDR');
  });

  it('asserts the capture directory exists, so exit 3 can only mean read errors', () => {
    // restic 0.19 exits 3 for a MISSING SOURCE PATH as well as for partial
    // read errors. Without this assert, a vanished capture directory would be
    // warned about and then recorded as a captured mailbox holding nothing.
    const s = script();
    expect(s).toContain('[ -d "$CAPTURE_ROOT/$ADDRDIR" ]');
    expect(s.indexOf('[ -d "$CAPTURE_ROOT/$ADDRDIR" ]'))
      .toBeLessThan(s.indexOf('restic -r "$REPO" backup'));
  });

  it('keeps the aux capture best-effort so a blip cannot cost the mail snapshot', () => {
    expect(script()).toContain('|| echo "AUX_WARN address=$ADDR');
  });

  it('reads credentials from the mounted Secret, never from argv', () => {
    const s = script();
    expect(s).toContain(`cat ${CREDS_MOUNT_PATH}/restic_password`);
    expect(s).not.toMatch(/RESTIC_PASSWORD=[0-9a-f]{8}/);
  });
});

describe('buildMailboxesCaptureScript input validation', () => {
  const base = {
    addresses: ['a@example.test'],
    tenantId: TENANT,
    backupId: BUNDLE,
    engine: 'imap' as const,
    jmapEndpoint: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    imapHost: 'stalwart-mail.mail.svc.cluster.local',
    imapPort: 993,
    stalwartMasterUser: 'master@example.test',
    tags: ['bundle=bkp-1111'],
  };

  it('rejects an address carrying shell metacharacters', () => {
    expect(() => buildMailboxesCaptureScript({ ...base, addresses: ['a@e.test; rm -rf /'] }))
      .toThrow(/invalid address/);
  });

  it('rejects a JMAP endpoint that is not http(s)://host[:port]', () => {
    expect(() => buildMailboxesCaptureScript({ ...base, jmapEndpoint: 'http://h/$(id)' }))
      .toThrow(/invalid jmapEndpoint/);
  });

  it('rejects a master user with shell metacharacters', () => {
    expect(() => buildMailboxesCaptureScript({ ...base, stalwartMasterUser: 'master`id`' }))
      .toThrow(/invalid stalwartMasterUser/);
  });

  it('rejects an imap host or port that could inject a flag', () => {
    expect(() => buildMailboxesCaptureScript({ ...base, imapHost: 'h --flag' }))
      .toThrow(/invalid imapHost/);
    expect(() => buildMailboxesCaptureScript({ ...base, imapPort: 0 }))
      .toThrow(/invalid imapPort/);
  });

  it('rejects a tenant id that could inject a restic flag through --host', () => {
    expect(() => buildMailboxesCaptureScript({ ...base, tenantId: 'x --repo /evil' }))
      .toThrow(/invalid tenantId/);
  });
});

describe('buildMailboxesResticJobSpec', () => {
  const spec = buildMailboxesResticJobSpec({
    jobName: 'bk-mbox-x',
    mailNamespace: 'mail',
    tenantId: TENANT,
    backupId: BUNDLE,
    toolsImage: 'ghcr.io/example/tenant-backup-tools:test',
    engine: 'imap',
    jmapEndpoint: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    imapHost: 'stalwart-mail.mail.svc.cluster.local',
    imapPort: 993,
    stalwartMasterUser: 'master@example.test',
    masterSecretName: 'mail-secrets',
    masterSecretKey: 'STALWART_MASTER_PASSWORD',
    credsSecretName: 'bk-mbox-creds-x',
    tags: ['bundle=bkp-1111'],
    addresses: ['a@example.test'],
    activeDeadlineSeconds: 3540,
  }) as any;

  const pod = spec.spec.template.spec;

  it('runs in the mail namespace with the labels the NetworkPolicy selects', () => {
    expect(spec.metadata.namespace).toBe('mail');
    expect(spec.metadata.labels['platform.io/component']).toBe('backup-files');
    expect(spec.metadata.labels['platform.io/sub-component']).toBe('backup-mailboxes');
    expect(spec.spec.template.metadata.labels['platform.io/backup-id']).toBe(BUNDLE);
  });

  it('mounts the capture tree and the restic cache as separate volumes', () => {
    const mounts = pod.containers[0].volumeMounts.map((m: any) => m.mountPath);
    expect(mounts).toContain(MAILBOX_CAPTURE_ROOT);
    expect(mounts).toContain('/tmp');
    const vols = Object.fromEntries(pod.volumes.map((v: any) => [v.name, v]));
    expect(vols.capture.emptyDir.sizeLimit).toBe('50Gi');
    expect(vols.scratch.emptyDir.sizeLimit).toBe('2Gi');
  });

  it('mounts the creds Secret read-only at mode 0400', () => {
    const creds = pod.volumes.find((v: any) => v.name === 'restic-creds');
    expect(creds.secret.defaultMode).toBe(0o400);
    const mount = pod.containers[0].volumeMounts.find((m: any) => m.name === 'restic-creds');
    expect(mount.readOnly).toBe(true);
  });

  it('takes the master password from a secretKeyRef, not the spec', () => {
    const env = pod.containers[0].env[0];
    expect(env.name).toBe('STALWART_MASTER_PASSWORD');
    expect(env.valueFrom.secretKeyRef.optional).toBe(false);
    expect(JSON.stringify(spec)).not.toContain('STALWART_MASTER_PASSWORD=');
  });

  it('does not retry — a half-captured bundle must fail loudly', () => {
    expect(spec.spec.backoffLimit).toBe(0);
    expect(spec.spec.activeDeadlineSeconds).toBe(3540);
  });
});

describe('parseMailboxDoneLines', () => {
  const log = [
    'Capturing mailbox a@example.test (#1 of 2)...',
    `MAILBOX_DONE bundleId=${BUNDLE} address=a@example.test snapshot=${'a'.repeat(64)} sizeBytes=1024 messages=7 addedBytes=512`,
    `MAILBOX_DONE bundleId=${BUNDLE} address=b@example.test snapshot=${'b'.repeat(64)} sizeBytes=0 messages=0 addedBytes=`,
    `MAILBOX_DONE bundleId=other-bundle address=c@example.test snapshot=${'c'.repeat(64)} sizeBytes=9 messages=1 addedBytes=9`,
    `MAILBOXES_DONE bundleId=${BUNDLE} captured=2 of 2`,
  ].join('\n');

  it('returns one result per captured mailbox', () => {
    const r = parseMailboxDoneLines(log, BUNDLE);
    expect(r.map((x) => x.address)).toEqual(['a@example.test', 'b@example.test']);
    expect(r[0].sizeBytes).toBe(1024);
    expect(r[0].messageCount).toBe(7);
    expect(r[0].dataAddedPacked).toBe(512);
  });

  it('ignores lines belonging to a different bundle', () => {
    expect(parseMailboxDoneLines(log, BUNDLE).some((x) => x.address === 'c@example.test'))
      .toBe(false);
  });

  it('carries the pre-compression size so the ratio is visible', () => {
    // restic reports data_added and data_added_packed on every snapshot. The
    // Job used to echo only the packed one, so the compression ratio could not
    // be read off a real capture at all.
    const line = `MAILBOX_DONE bundleId=${BUNDLE} address=a@example.test snapshot=${'a'.repeat(64)} sizeBytes=100 messages=2 addedBytes=30 rawBytes=90`;
    const r = parseMailboxDoneLines(line, BUNDLE)[0];
    expect(r.dataAddedRaw).toBe(90);
    expect(r.dataAddedPacked).toBe(30);
  });

  it('reports an unmeasured rawBytes as null, never 0', () => {
    const line = `MAILBOX_DONE bundleId=${BUNDLE} address=a@example.test snapshot=${'a'.repeat(64)} sizeBytes=100 messages=2 addedBytes=30 rawBytes=`;
    expect(parseMailboxDoneLines(line, BUNDLE)[0].dataAddedRaw).toBeNull();
  });

  it('reports an unmeasured addedBytes as null, never 0', () => {
    // 0 is a legitimate measurement for a mailbox with no new mail; conflating
    // the two makes an unmeasured run read as measured.
    const r = parseMailboxDoneLines(log, BUNDLE);
    expect(r[1].dataAddedPacked).toBeNull();
    expect(parseMailboxDoneLines(
      `MAILBOX_DONE bundleId=${BUNDLE} address=z@example.test snapshot=${'d'.repeat(64)} sizeBytes=5 messages=1 addedBytes=0`,
      BUNDLE,
    )[0].dataAddedPacked).toBe(0);
  });

  it('drops a line whose snapshot id is not a full restic id', () => {
    expect(parseMailboxDoneLines(
      `MAILBOX_DONE bundleId=${BUNDLE} address=z@example.test snapshot=deadbeef sizeBytes=5 messages=1 addedBytes=1`,
      BUNDLE,
    )).toEqual([]);
  });

  it('returns nothing for a log with no capture lines', () => {
    expect(parseMailboxDoneLines('nothing here\n', BUNDLE)).toEqual([]);
  });
});
