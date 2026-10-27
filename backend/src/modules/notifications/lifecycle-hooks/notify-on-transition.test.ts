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

  it('a suspension that ends a restore from archive tells the tenant it was restored, not suspended', async () => {
    const r = await notifyOnTransitionHook.run(ctx({ transition: 'suspended', restoredFromArchive: true }) as never);
    expect(r.status).toBe('ok');
    expect(emitEventMock).toHaveBeenCalledTimes(1);
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

describe('what the archive and restore notices say', () => {
  const dbReturning = (rows: unknown[]) => ({
    select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(rows), { orderBy: () => ({ limit: async () => rows }) }) }) }),
  });
  const vars = () => (emitEventMock.mock.calls[0][1] as { variables: Record<string, string> }).variables;

  it('archived: how long the backup is kept', async () => {
    await notifyOnTransitionHook.run(ctx({ transition: 'archived', db: dbReturning([{ expiresAt: new Date('2027-01-18T10:00:00Z') }]) }) as never);
    expect(vars().keptUntil).toBe('until January 18, 2027');
  });

  it('archived with no expiry: kept with no end date', async () => {
    await notifyOnTransitionHook.run(ctx({ transition: 'archived', db: dbReturning([{ expiresAt: null }]) }) as never);
    expect(vars().keptUntil).toBe('with no end date');
  });

  it('archived, details unreadable: still sent, vaguer', async () => {
    await notifyOnTransitionHook.run(ctx({ transition: 'archived', db: {} }) as never);
    expect(vars().keptUntil).toBe('for a limited time');
  });

  it('restored with mailboxes: they need new passwords', async () => {
    await notifyOnTransitionHook.run(ctx({ transition: 'restored', db: dbReturning([{ n: 3 }]) }) as never);
    expect(vars().mailboxNote).toContain('new password');
  });

  it('restored without mailboxes: no mailbox note', async () => {
    await notifyOnTransitionHook.run(ctx({ transition: 'restored', db: dbReturning([{ n: 0 }]) }) as never);
    expect(vars().mailboxNote).toBeUndefined();
  });
});
