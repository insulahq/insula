import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bound = vi.hoisted(() => ({ id: null as string | null, fail: false, served: true }));
vi.mock('../backup-rclone-shim/served.js', () => ({ shimServesCurrentBindings: vi.fn(async () => bound.served) }));
vi.mock('../backup-source-shim/service.js', async (orig) => ({
  ...(await orig<typeof import('../backup-source-shim/service.js')>()),
  boundTenantTargetId: vi.fn(async () => {
    if (bound.fail) throw new Error('db down');
    return bound.id;
  }),
}));

const { onUnboundTarget, requireBundleOnBoundTarget, targetPlacements } = await import('./unbound-target.js');

const BOUND = 'cfg-bound';
const OLD = 'cfg-old';
/** A db whose only query is the target-name lookup. */
const db = (rows: Array<{ id: string; name: string }>) => ({
  select: () => ({ from: () => ({ where: async () => rows }) }),
}) as never;
const log = { warn: vi.fn() };
const k8s = {} as never;

describe('bundles on a target tenant backups are no longer bound to', () => {
  const savedKey = process.env.PLATFORM_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.PLATFORM_ENCRYPTION_KEY = 'a'.repeat(64);
    bound.id = BOUND;
    bound.fail = false;
    bound.served = true;
    log.warn.mockClear();
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.PLATFORM_ENCRYPTION_KEY;
    else process.env.PLATFORM_ENCRYPTION_KEY = savedKey;
  });

  it('onUnboundTarget: another target is unbound, the bound one and no target are not, unknown is null', () => {
    expect(onUnboundTarget(OLD, { known: true, id: BOUND })).toBe(true);
    expect(onUnboundTarget(BOUND, { known: true, id: BOUND })).toBe(false);
    expect(onUnboundTarget(null, { known: true, id: BOUND })).toBe(false);
    expect(onUnboundTarget(OLD, { known: true, id: null })).toBe(true);
    expect(onUnboundTarget(OLD, { known: false, reason: 'unresolved' })).toBeNull();
    expect(onUnboundTarget(null, { known: false, reason: 'switching' })).toBe(false);
  });

  it('a delete on the bound target, or of a bundle naming none, goes ahead', async () => {
    await expect(requireBundleOnBoundTarget(db([]), k8s, BOUND, log)).resolves.toBeUndefined();
    await expect(requireBundleOnBoundTarget(db([]), k8s, null, log)).resolves.toBeUndefined();
  });

  it('a delete on another target is refused, naming the target and what to do', async () => {
    const err = await requireBundleOnBoundTarget(db([{ id: OLD, name: 'old-sftp' }]), k8s, OLD, log).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'BUNDLE_ON_UNBOUND_TARGET',
      status: 409,
      details: { targetConfigId: OLD, targetName: 'old-sftp' },
    });
    expect(String((err as Error).message)).toContain("stored on 'old-sftp'");
    expect((err as { remediation?: string }).remediation).toMatch(/Bind tenant backups to 'old-sftp' again/);
  });

  it('a bound target that cannot be told refuses the delete rather than guess', async () => {
    bound.fail = true;
    await expect(requireBundleOnBoundTarget(db([]), k8s, BOUND, log)).rejects.toMatchObject({ code: 'BOUND_TARGET_UNKNOWN', status: 503 });
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    bound.fail = false;
    await expect(requireBundleOnBoundTarget(db([]), k8s, BOUND, log)).rejects.toMatchObject({ code: 'BOUND_TARGET_UNKNOWN' });
    expect(log.warn).toHaveBeenCalled();
  });

  // The binding is written to the database first, and the shim serves it only
  // once rolled: until then a delete would act on the previous target.
  it('while the shim has not rolled onto the binding, a delete waits — even one on the new bound target', async () => {
    bound.served = false;
    await expect(requireBundleOnBoundTarget(db([]), k8s, BOUND, log)).rejects.toMatchObject({ code: 'BOUND_TARGET_SWITCHING', status: 503 });
    await expect(requireBundleOnBoundTarget(db([]), k8s, null, log)).resolves.toBeUndefined();
    const place = await targetPlacements(db([{ id: BOUND, name: 'now' }]), k8s, [BOUND], log);
    expect(place(BOUND)).toBeNull();
  });

  it('placements: name and whether bound; none for no target, an unconfigured one, or an unknown binding', async () => {
    const place = await targetPlacements(db([{ id: BOUND, name: 'now' }, { id: OLD, name: 'before' }]), k8s, [BOUND, OLD, 'cfg-gone', null], log);
    expect(place(BOUND)).toEqual({ name: 'now', bound: true });
    expect(place(OLD)).toEqual({ name: 'before', bound: false });
    expect(place('cfg-gone')).toBeNull();
    expect(place(null)).toBeNull();
    bound.fail = true;
    const unknown = await targetPlacements(db([{ id: OLD, name: 'before' }]), k8s, [OLD], log);
    expect(unknown(OLD)).toBeNull();
  });
});
