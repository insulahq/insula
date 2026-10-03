import { describe, expect, it } from 'vitest';
import { operatorNotificationText, tenantVisibleText } from './operator-only-text.js';

const ERR = 'files: files-component Job bk-files-x failed: DeadlineExceeded: Job was active longer than specified deadline'
  + '; diagnosis: pod bk-files-x-1 on node node-a never started (ContainerCreating) [pinned to node node-a (mounted)]'
  + '; logs: restic: secret stderr';

describe('tenantVisibleText', () => {
  it('cuts at the diagnosis — no node or pod name reaches a tenant', () => {
    const t = tenantVisibleText(ERR);
    expect(t).toBe('files: files-component Job bk-files-x failed: DeadlineExceeded: Job was active longer than specified deadline');
    expect(t).not.toMatch(/node-a|bk-files-x-1|restic/);
  });

  it('cuts at the logs when there is no diagnosis', () => {
    expect(tenantVisibleText('mailboxes: failed: BackoffLimitExceeded; logs: stderr')).toBe('mailboxes: failed: BackoffLimitExceeded');
  });

  it('leaves a plain error alone', () => {
    expect(tenantVisibleText('files cluster gate refused')).toBe('files cluster gate refused');
  });
});

describe('operatorNotificationText', () => {
  it('keeps the diagnosis and drops the pod logs', () => {
    const t = operatorNotificationText(ERR);
    expect(t).toContain('node node-a never started');
    expect(t).not.toContain('secret stderr');
  });
});
