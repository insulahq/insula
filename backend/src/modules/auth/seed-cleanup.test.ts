import { describe, it, expect, vi } from 'vitest';
import {
  deleteAdminSeedSecret,
  BOOTSTRAP_SEED_NAMESPACE,
  BOOTSTRAP_SEED_NAME,
} from './seed-cleanup.js';

describe('deleteAdminSeedSecret', () => {
  it('returns cleared=true when the Secret deletion succeeds', async () => {
    const deleteSecret = vi.fn().mockResolvedValue(undefined);
    const result = await deleteAdminSeedSecret({ deleteSecret });
    expect(result).toEqual({ cleared: true, reason: 'deleted' });
    expect(deleteSecret).toHaveBeenCalledWith(
      BOOTSTRAP_SEED_NAMESPACE,
      BOOTSTRAP_SEED_NAME,
    );
  });

  it('returns cleared=false reason=not_found when the Secret is already absent (404)', async () => {
    // @kubernetes/client-node v1 shape: ApiException with `code: 404`
    const notFoundErr = Object.assign(new Error('secrets not found'), {
      code: 404,
    });
    const deleteSecret = vi.fn().mockRejectedValue(notFoundErr);
    const result = await deleteAdminSeedSecret({ deleteSecret });
    expect(result).toEqual({ cleared: false, reason: 'not_found' });
  });

  it('returns cleared=false reason=not_found on v0 SDK 404 shape (response.statusCode)', async () => {
    // Legacy @kubernetes/client-node v0 shape: error with
    // `response.statusCode: 404`. isNotFound() accepts both.
    const v0Err = Object.assign(new Error('not found'), {
      response: { statusCode: 404 },
    });
    const deleteSecret = vi.fn().mockRejectedValue(v0Err);
    const result = await deleteAdminSeedSecret({ deleteSecret });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('returns cleared=false reason=error with message on non-404 API error', async () => {
    const apiErr = Object.assign(new Error('apiserver unreachable'), {
      code: 503,
    });
    const deleteSecret = vi.fn().mockRejectedValue(apiErr);
    const result = await deleteAdminSeedSecret({ deleteSecret });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe('error');
    if (result.reason === 'error') {
      expect(result.error).toBe('apiserver unreachable');
    }
  });

  it('returns cleared=false reason=error for non-Error throws (preserves String() output)', async () => {
    const deleteSecret = vi.fn().mockRejectedValue('plain string failure');
    const result = await deleteAdminSeedSecret({ deleteSecret });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe('error');
    if (result.reason === 'error') {
      expect(result.error).toBe('plain string failure');
    }
  });

  it('targets the platform namespace + platform-admin-seed name (not a different Secret)', async () => {
    expect(BOOTSTRAP_SEED_NAMESPACE).toBe('platform');
    expect(BOOTSTRAP_SEED_NAME).toBe('platform-admin-seed');
    // Defensive: catches an accidental rename in seed-cleanup.ts.
    const deleteSecret = vi.fn().mockResolvedValue(undefined);
    await deleteAdminSeedSecret({ deleteSecret });
    const [ns, name] = deleteSecret.mock.calls[0];
    expect(ns).toBe('platform');
    expect(name).toBe('platform-admin-seed');
  });
});
