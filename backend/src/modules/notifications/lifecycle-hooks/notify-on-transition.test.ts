import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitEventMock = vi.fn().mockResolvedValue({
  eventId: 'e1',
  deliveryCount: 1,
  perChannelStatuses: [],
});
vi.mock('../dispatcher/dispatch.js', () => ({ emitEvent: emitEventMock }));

const { notifyOnTransitionHook } = await import('./notify-on-transition.js');

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    db: {} as never,
    k8s: {} as never,
    tenantId: 't1',
    namespace: 'tenant-t1',
    transitionId: 'tr1',
    transition: 'suspended' as const,
    attempt: 1,
    ...overrides,
  };
}

beforeEach(() => emitEventMock.mockClear());

describe('notify-tenant-on-transition hook', () => {
  it('maps suspended → tenant.suspended category', async () => {
    const r = await notifyOnTransitionHook.run(ctx({ transition: 'suspended' }) as never);
    expect(r.status).toBe('ok');
    expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
      categoryId: 'tenant.suspended',
      scope: { kind: 'tenant', tenantId: 't1' },
    }));
  });

  it('maps restored → tenant.restored', async () => {
    const r = await notifyOnTransitionHook.run(ctx({ transition: 'restored' }) as never);
    expect(r.status).toBe('ok');
    expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({ categoryId: 'tenant.restored' }));
  });

  it('maps archived and deleted to their categories', async () => {
    await notifyOnTransitionHook.run(ctx({ transition: 'archived' }) as never);
    expect(emitEventMock.mock.calls[0][1]).toMatchObject({ categoryId: 'tenant.archived' });
    emitEventMock.mockClear();
    await notifyOnTransitionHook.run(ctx({ transition: 'deleted' }) as never);
    expect(emitEventMock.mock.calls[0][1]).toMatchObject({ categoryId: 'tenant.deleted' });
  });

  it('passes suppressTenantNotification through when set', async () => {
    await notifyOnTransitionHook.run(ctx({ suppressTenantNotification: true }) as never);
    expect(emitEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
      suppressTenantNotification: true,
    }));
  });

  it('noop for transitions with no mapped category (e.g. active)', async () => {
    const r = await notifyOnTransitionHook.run(ctx({ transition: 'active' }) as never);
    expect(r.status).toBe('noop');
    expect(emitEventMock).not.toHaveBeenCalled();
  });

  it('returns failed (but blocking=continue) when emitEvent throws', async () => {
    emitEventMock.mockRejectedValueOnce(new Error('dispatcher boom'));
    const r = await notifyOnTransitionHook.run(ctx() as never);
    expect(r.status).toBe('failed');
    expect(r.envelope?.title).toMatch(/notification dispatch/i);
  });

  it('declares the correct registry metadata', () => {
    expect(notifyOnTransitionHook.name).toBe('notify-tenant-on-transition');
    expect(notifyOnTransitionHook.order).toBe(900);
    expect(notifyOnTransitionHook.blocking).toBe('continue');
    expect(notifyOnTransitionHook.transitions).toEqual(['suspended', 'restored', 'archived', 'deleted']);
  });
});
