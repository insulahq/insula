import { describe, it, expect, vi } from 'vitest';
import { reconcilePlatformSecretsMirror } from './mirror-reconciler.js';

/**
 * Build a fake CoreV1Api whose readNamespacedSecret returns per-namespace
 * fixtures (or throws for absent ones) and whose replaceNamespacedSecret is a spy.
 */
function fakeCore(opts: {
  platform?: Record<string, string> | null;
  platformSystem?: Record<string, string> | null;
  replaceThrows?: boolean;
}) {
  const replace = vi.fn(async () => {
    if (opts.replaceThrows) throw new Error('boom');
    return {};
  });
  const read = vi.fn(async ({ namespace }: { namespace: string }) => {
    const data = namespace === 'platform' ? opts.platform : opts.platformSystem;
    if (data == null) {
      const err = new Error('not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', data };
  });
  return {
    core: { readNamespacedSecret: read, replaceNamespacedSecret: replace } as never,
    read,
    replace,
  };
}

describe('reconcilePlatformSecretsMirror', () => {
  it('is a no-op when the mirror already matches the source', async () => {
    const { core, replace } = fakeCore({
      platform: { 'internal-secret': 'QUJD', 'platform-encryption-key': 'RUZH' },
      platformSystem: { 'internal-secret': 'QUJD', 'platform-encryption-key': 'RUZH' },
    });
    const res = await reconcilePlatformSecretsMirror(core);
    expect(res.status).toBe('in-sync');
    expect(res.driftedKeys).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
  });

  it('heals a drifted internal-secret and preserves untouched keys', async () => {
    const { core, replace } = fakeCore({
      platform: { 'internal-secret': 'NEW=', 'platform-encryption-key': 'RUZH' },
      platformSystem: { 'internal-secret': 'OLD=', 'platform-encryption-key': 'RUZH' },
    });
    const res = await reconcilePlatformSecretsMirror(core);
    expect(res.status).toBe('healed');
    expect(res.driftedKeys).toEqual(['internal-secret']);
    expect(replace).toHaveBeenCalledOnce();
    const body = replace.mock.calls[0][0].body;
    // corrected key copied from source; other key preserved
    expect(body.data['internal-secret']).toBe('NEW=');
    expect(body.data['platform-encryption-key']).toBe('RUZH');
    expect(body.metadata.namespace).toBe('platform-system');
  });

  it('heals both keys when both drift', async () => {
    const { core, replace } = fakeCore({
      platform: { 'internal-secret': 'A1', 'platform-encryption-key': 'B1' },
      platformSystem: { 'internal-secret': 'A0', 'platform-encryption-key': 'B0' },
    });
    const res = await reconcilePlatformSecretsMirror(core);
    expect(res.status).toBe('healed');
    expect([...res.driftedKeys].sort()).toEqual(['internal-secret', 'platform-encryption-key']);
    expect(replace.mock.calls[0][0].body.data).toMatchObject({ 'internal-secret': 'A1', 'platform-encryption-key': 'B1' });
  });

  it('skips when the source secret is absent', async () => {
    const { core, replace } = fakeCore({ platform: null, platformSystem: { 'internal-secret': 'X' } });
    const res = await reconcilePlatformSecretsMirror(core);
    expect(res.status).toBe('skipped');
    expect(replace).not.toHaveBeenCalled();
  });

  it('skips when the mirror secret is absent (does not create it)', async () => {
    const { core, replace } = fakeCore({ platform: { 'internal-secret': 'X' }, platformSystem: null });
    const res = await reconcilePlatformSecretsMirror(core);
    expect(res.status).toBe('skipped');
    expect(replace).not.toHaveBeenCalled();
  });

  it('ignores keys present only in the source (mirror stays a superset target)', async () => {
    // platform-encryption-key missing from source → not forced onto the mirror.
    const { core, replace } = fakeCore({
      platform: { 'internal-secret': 'SAME' },
      platformSystem: { 'internal-secret': 'SAME', 'platform-encryption-key': 'KEEP' },
    });
    const res = await reconcilePlatformSecretsMirror(core);
    expect(res.status).toBe('in-sync');
    expect(replace).not.toHaveBeenCalled();
  });

  it('reports failed (never throws) when the patch call errors', async () => {
    const { core } = fakeCore({
      platform: { 'internal-secret': 'NEW' },
      platformSystem: { 'internal-secret': 'OLD' },
      replaceThrows: true,
    });
    const res = await reconcilePlatformSecretsMirror(core);
    expect(res.status).toBe('failed');
    expect(res.driftedKeys).toEqual(['internal-secret']);
  });

  it('never logs a secret VALUE — only key names', async () => {
    const warn = vi.fn();
    const { core } = fakeCore({
      platform: { 'internal-secret': 'SUPERSECRETVALUE' },
      platformSystem: { 'internal-secret': 'OLD' },
    });
    await reconcilePlatformSecretsMirror(core, { info: vi.fn(), warn });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('SUPERSECRETVALUE');
    expect(logged).not.toContain('OLD');
    expect(logged).toContain('internal-secret');
  });
});
