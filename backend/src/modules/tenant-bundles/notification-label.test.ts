import { describe, expect, it } from 'vitest';
import { findIds } from '../notifications/dispatcher/envelope.js';
import { bundleNotificationLabel, notificationErrorText } from './notification-label.js';

const BUNDLE = 'bkp-11111111-2222-4333-8444-555555555555';
const TENANT = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

describe('bundleNotificationLabel', () => {
  const startedAt = new Date('2026-10-03T01:44:36.521Z');

  it('names an unlabelled bundle by when it ran — never by its id', () => {
    const label = bundleNotificationLabel({ label: null, startedAt });
    expect(label).toBe('run of 2026-10-03 01:44 UTC');
    // The id is what rendered as "bkp-(unnamed)": the dispatcher replaces every
    // UUID it cannot name. A label with no UUID cannot be mangled.
    expect(findIds(label)).toEqual([]);
  });

  it('leads with the operator-given label when there is one', () => {
    expect(bundleNotificationLabel({ label: '  before upgrade ', startedAt }))
      .toBe('"before upgrade" (run of 2026-10-03 01:44 UTC)');
    expect(bundleNotificationLabel({ label: '   ', startedAt })).toBe('run of 2026-10-03 01:44 UTC');
  });
});

describe('notificationErrorText', () => {
  // The shape files.ts:waitForJob throws for the production failure.
  const CAPTURE_ERR = `files: files-component Job bk-files-${BUNDLE} failed: `
    + 'DeadlineExceeded: Job was active longer than specified deadline'
    + '; diagnosis: pinned to node node-a (mounted); '
    + `pod bk-files-${BUNDLE}-abcde on node node-a never started (ContainerCreating); `
    + 'FailedAttachVolume: Multi-Attach error for volume "vol-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" '
    + 'Volume is already used by pod(s) app-1'
    + '; logs: restic stderr';

  it('gives a tenant the headline only — no node, pod, event text or logs', () => {
    const text = notificationErrorText([CAPTURE_ERR], BUNDLE, 'tenant');
    expect(text).toBe('files: files-component Job failed: DeadlineExceeded: Job was active longer than specified deadline');
    expect(text).not.toMatch(/node-a|app-1|vol-|restic|diagnosis/);
    expect(findIds(text)).toEqual([]);
  });

  it('gives an operator the diagnosis, without the pod logs or a "(unnamed)"-bound id', () => {
    const text = notificationErrorText([CAPTURE_ERR], BUNDLE, 'operator');
    expect(text).toBe(
      'files: files-component Job failed: DeadlineExceeded: Job was active longer than specified deadline'
      + '; diagnosis: pinned to node node-a (mounted); pod on node node-a never started (ContainerCreating); '
      + 'FailedAttachVolume: Multi-Attach error for volume "vol-aaaaaaaa…" Volume is already used by pod(s) app-1',
    );
    expect(text).not.toContain('restic stderr');
    expect(findIds(text)).toEqual([]);
  });

  it('leaves a bare id for the dispatcher, which names tenants, users, mailboxes and domains', () => {
    expect(notificationErrorText([`restic repo restic-files/${TENANT} is locked`], BUNDLE, 'tenant'))
      .toBe(`restic repo restic-files/${TENANT} is locked`);
  });

  it('cuts every error, not just the first, and caps the total', () => {
    expect(notificationErrorText(['files: boom; logs: secret stderr', 'mailboxes: bang; diagnosis: node-a'], BUNDLE, 'tenant'))
      .toBe('files: boom; mailboxes: bang');
    expect(notificationErrorText(['x'.repeat(2000)], BUNDLE, 'operator', 500)).toHaveLength(500);
  });
});
