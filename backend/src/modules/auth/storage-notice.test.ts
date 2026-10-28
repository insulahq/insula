import { describe, expect, it } from 'vitest';
import { buildStorageNotice, workloadLabel } from './storage-notice.js';

const base = { activeOpType: null, latestOpType: null, downWorkloads: [] } as const;

describe('buildStorageNotice', () => {
  it('says nothing while the tenant is idle', () => {
    expect(buildStorageNotice({ ...base, state: 'idle' })).toBeNull();
    expect(buildStorageNotice({ ...base, state: null })).toBeNull();
  });

  it('reports a running operation with its type', () => {
    expect(buildStorageNotice({ ...base, state: 'resizing', activeOpType: 'resize' }))
      .toEqual({ kind: 'operation_running', opType: 'resize' });
    expect(buildStorageNotice({ ...base, state: 'quiescing', activeOpType: 'autoheal' }))
      .toEqual({ kind: 'operation_running', opType: 'autoheal' });
  });

  it('turns a failed automatic restart into the applications that are down', () => {
    // Production: the auto-heal could not admit sitewright under a full quota.
    expect(buildStorageNotice({
      ...base, state: 'failed', latestOpType: 'autoheal', downWorkloads: ['sitewright'],
    })).toEqual({ kind: 'workloads_down', workloads: ['sitewright'] });
  });

  it('labels platform components and de-duplicates', () => {
    expect(buildStorageNotice({
      ...base, state: 'failed', latestOpType: 'autoheal',
      downWorkloads: ['private-worker-server', 'blog', 'blog'],
    })).toEqual({ kind: 'workloads_down', workloads: ['blog', 'Private worker server'] });
  });

  it('says nothing for a failed automatic restart once everything runs again', () => {
    expect(buildStorageNotice({ ...base, state: 'failed', latestOpType: 'autoheal', downWorkloads: [] })).toBeNull();
  });

  it('reports any other failed operation by type, even with a workload down', () => {
    expect(buildStorageNotice({ ...base, state: 'failed', latestOpType: 'resize', downWorkloads: ['blog'] }))
      .toEqual({ kind: 'operation_failed', opType: 'resize' });
    expect(buildStorageNotice({ ...base, state: 'failed', latestOpType: null }))
      .toEqual({ kind: 'operation_failed', opType: null });
  });
});

describe('workloadLabel', () => {
  it('keeps an application name and labels platform components', () => {
    expect(workloadLabel('my-wordpress')).toBe('my-wordpress');
    expect(workloadLabel('file-manager')).toBe('File manager');
  });
});
