import { describe, it, expect, vi } from 'vitest';
import type { CoreV1Api } from '@kubernetes/client-node';
import { targetUnschedulableReason } from './migration.js';

const core = (node: unknown): CoreV1Api => ({ readNode: vi.fn(async () => node) }) as unknown as CoreV1Api;

describe('targetUnschedulableReason — the migration preflight before the PVC swap', () => {
  it('refuses a cordoned target, naming it and saying nothing was changed', async () => {
    const why = await targetUnschedulableReason(core({ spec: { unschedulable: true } }), 's2');
    expect(why).toContain("'s2' is cordoned");
    expect(why).toContain('Nothing was changed');
  });

  it('passes a schedulable target', async () => {
    expect(await targetUnschedulableReason(core({ spec: {} }), 's3')).toBeNull();
  });

  it('leaves an unreadable node to the restore-readiness check', async () => {
    const failing = { readNode: vi.fn(async () => { throw new Error('nodes "x" not found'); }) } as unknown as CoreV1Api;
    expect(await targetUnschedulableReason(failing, 'x')).toBeNull();
  });
});
