import { describe, it, expect, vi, beforeEach } from 'vitest';

const { destroySpy } = vi.hoisted(() => ({
  destroySpy: vi.fn(async () => undefined),
}));

vi.mock('../../email-domains/service.js', () => ({
  destroyStalwartArtifactsForEmailDomain: destroySpy,
}));

import { stalwartEmailCleanupHook } from './stalwart-email-cleanup.js';
import type { HookCtx } from '../registry/index.js';

const updates: Array<Record<string, unknown>> = [];

function makeCtx(
  rows: Array<{ id: string; stalwartDomainId: string | null }>,
  transition: 'deleted' | 'archived' = 'deleted',
): HookCtx {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: async () => rows,
        }),
      }),
      update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { updates.push(patch); } }) }),
    } as never,
    k8s: {} as never,
    tenantId: 'c1',
    namespace: 'tenant-test',
    transitionId: 't1',
    transition,
    attempt: 1,
  };
}

describe('stalwart-email-cleanup hook', () => {
  beforeEach(() => {
    destroySpy.mockReset().mockResolvedValue(undefined);
    updates.length = 0;
  });

  it('is registered for deleted and archived, non-blocking', () => {
    expect(stalwartEmailCleanupHook.transitions).toEqual(['deleted', 'archived']);
    expect(stalwartEmailCleanupHook.blocking).toBe('continue');
  });

  it('on archive, the kept rows forget the mail server ids — restore builds the domain and its mailboxes again', async () => {
    const r = await stalwartEmailCleanupHook.run(makeCtx([{ id: 'ed1', stalwartDomainId: 'sd1' }], 'archived'));
    expect(r.status).toBe('ok');
    expect(updates).toEqual([{ stalwartPrincipalId: null }, { stalwartDomainId: null }]);
  });

  it('on archive, a Domain that could not be removed keeps its id', async () => {
    destroySpy.mockResolvedValueOnce({ domainDestroyed: false, failures: ['unreachable'] } as never);
    await stalwartEmailCleanupHook.run(makeCtx([{ id: 'ed1', stalwartDomainId: 'sd1' }], 'archived'));
    expect(updates).toEqual([]);
  });

  it('on delete, writes nothing — the rows go with the tenant', async () => {
    await stalwartEmailCleanupHook.run(makeCtx([{ id: 'ed1', stalwartDomainId: 'sd1' }], 'deleted'));
    expect(updates).toEqual([]);
  });

  it('returns ok with no email domains', async () => {
    const r = await stalwartEmailCleanupHook.run(makeCtx([]));
    expect(r.status).toBe('ok');
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('destroys Stalwart artifacts for every provisioned email domain', async () => {
    const rows = [
      { id: 'ed1', stalwartDomainId: 'a' },
      { id: 'ed2', stalwartDomainId: 'b' },
    ];
    const r = await stalwartEmailCleanupHook.run(makeCtx(rows));
    expect(r.status).toBe('ok');
    expect(destroySpy).toHaveBeenCalledTimes(2);
    expect(destroySpy).toHaveBeenCalledWith(expect.anything(), rows[0]);
    expect(destroySpy).toHaveBeenCalledWith(expect.anything(), rows[1]);
    expect(r.detail).toContain('2/2');
  });

  it('skips rows that were never provisioned to Stalwart', async () => {
    const rows = [
      { id: 'ed1', stalwartDomainId: null },
      { id: 'ed2', stalwartDomainId: 'b' },
    ];
    const r = await stalwartEmailCleanupHook.run(makeCtx(rows));
    expect(r.status).toBe('ok');
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(r.detail).toContain('1/2');
  });
});
