import { describe, it, expect, vi } from 'vitest';
import { requireWritableTarget, TargetFrozenError } from './writable-guard.js';
import { ApiError } from '../../shared/errors.js';

function createMockDb(row: { name: string; readOnly: boolean } | undefined) {
  const limitFn = vi.fn().mockReturnValue(Promise.resolve(row ? [row] : []));
  const whereFn = vi.fn().mockImplementation(() => {
    const chain: PromiseLike<unknown[]> & { limit: typeof limitFn } = {
      limit: limitFn,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(row ? [row] : []).then(onFulfilled, onRejected),
    };
    return chain;
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as unknown as Parameters<typeof requireWritableTarget>[0];
}

describe('requireWritableTarget', () => {
  it('returns null for null/empty target id (caller decides reject)', async () => {
    const db = createMockDb(undefined);
    await expect(requireWritableTarget(db, null)).resolves.toBeNull();
    await expect(requireWritableTarget(db, undefined)).resolves.toBeNull();
    await expect(requireWritableTarget(db, '')).resolves.toBeNull();
  });

  it('returns target name when target is writable (read_only=false)', async () => {
    const db = createMockDb({ name: 'Hetzner SSH', readOnly: false });
    await expect(requireWritableTarget(db, 'cfg-1')).resolves.toBe('Hetzner SSH');
  });

  it('throws TargetFrozenError when target is read-only', async () => {
    const db = createMockDb({ name: 'Hetzner S3', readOnly: true });
    await expect(requireWritableTarget(db, 'cfg-2')).rejects.toThrowError(TargetFrozenError);
  });

  it('throws ApiError with TARGET_FROZEN code + 409 status on frozen target', async () => {
    const db = createMockDb({ name: 'Frozen Target', readOnly: true });
    try {
      await requireWritableTarget(db, 'cfg-3');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as TargetFrozenError;
      expect(e.code).toBe('TARGET_FROZEN');
      expect(e.status).toBe(409);
      expect(e.message).toContain('Frozen Target');
      expect(e.message).toContain('read-only');
      expect(e.targetId).toBe('cfg-3');
      expect(e.targetName).toBe('Frozen Target');
    }
  });

  it('throws BACKUP_CONFIG_NOT_FOUND when target id unknown', async () => {
    const db = createMockDb(undefined);
    try {
      await requireWritableTarget(db, 'cfg-missing');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe('BACKUP_CONFIG_NOT_FOUND');
      expect(e.status).toBe(404);
    }
  });
});
