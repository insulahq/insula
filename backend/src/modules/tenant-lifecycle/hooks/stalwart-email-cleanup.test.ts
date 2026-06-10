import { describe, it, expect, vi, beforeEach } from 'vitest';

const { destroySpy } = vi.hoisted(() => ({
  destroySpy: vi.fn(async () => undefined),
}));

vi.mock('../../email-domains/service.js', () => ({
  destroyStalwartArtifactsForEmailDomain: destroySpy,
}));

import { stalwartEmailCleanupHook } from './stalwart-email-cleanup.js';
import type { HookCtx } from '../registry/index.js';

function makeCtx(
  rows: Array<{ id: string; stalwartDomainId: string | null }>,
): HookCtx {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: async () => rows,
        }),
      }),
    } as never,
    k8s: {} as never,
    tenantId: 'c1',
    namespace: 'tenant-test',
    transitionId: 't1',
    transition: 'deleted',
    attempt: 1,
  };
}

describe('stalwart-email-cleanup hook', () => {
  beforeEach(() => {
    destroySpy.mockReset().mockResolvedValue(undefined);
  });

  it('is registered for the deleted transition only, non-blocking', () => {
    expect(stalwartEmailCleanupHook.transitions).toEqual(['deleted']);
    expect(stalwartEmailCleanupHook.blocking).toBe('continue');
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
