import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reconcilePullSecrets } from './pull-secret-reconciler.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

vi.mock('./pat-store.js', async (orig) => {
  const actual = await orig<typeof import('./pat-store.js')>();
  return {
    ...actual,
    loadDecryptedToken: vi.fn(),
    materializePullSecret: vi.fn(async () => 'image-pull-x'),
  };
});
import { loadDecryptedToken, materializePullSecret } from './pat-store.js';

const loadDecryptedTokenMock = loadDecryptedToken as unknown as ReturnType<typeof vi.fn>;
const materializeMock = materializePullSecret as unknown as ReturnType<typeof vi.fn>;

interface Row { deploymentId: string; namespace: string; tenantId: string }

function stubDb(rows: Row[]): Database {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(async () => rows),
        })),
      })),
    })),
  } as unknown as Database;
}

/** `present` lists the secret names the cluster already has. */
function stubK8s(present: string[]): K8sClients {
  return {
    core: {
      readNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
        if (present.includes(name)) return { metadata: { name } };
        // Shape the k8s client actually throws; `isNotFound` reads `.code`.
        throw Object.assign(new Error('not found'), { code: 404 });
      }),
    } as unknown as K8sClients['core'],
    apps: {} as K8sClients['apps'],
    networking: {} as K8sClients['networking'],
  };
}

const ROWS: Row[] = [
  { deploymentId: 'dep-a', namespace: 'tenant-a', tenantId: 't1' },
  { deploymentId: 'dep-b', namespace: 'tenant-b', tenantId: 't2' },
];

describe('reconcilePullSecrets', () => {
  const originalKey = process.env.PLATFORM_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PLATFORM_ENCRYPTION_KEY = 'k'.repeat(32);
    loadDecryptedTokenMock.mockResolvedValue({
      registryHost: 'ghcr.io', username: 'u', token: 'tok',
    });
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.PLATFORM_ENCRYPTION_KEY;
    else process.env.PLATFORM_ENCRYPTION_KEY = originalKey;
  });

  // The restore case: the credential ROW comes back in the bundle, the Secret
  // does not. Without this sweep the Pod references a Secret that isn't there.
  it('recreates a Secret that is missing', async () => {
    const s = await reconcilePullSecrets(stubDb(ROWS), stubK8s([]));
    expect(s.examined).toBe(2);
    expect(s.repaired).toBe(2);
    expect(s.failures).toEqual([]);
    expect(materializeMock).toHaveBeenCalledTimes(2);
  });

  // Read-mostly: an hourly sweep must not rewrite Secrets that are fine.
  it('leaves an existing Secret alone', async () => {
    const s = await reconcilePullSecrets(stubDb(ROWS), stubK8s(['image-pull-dep-a', 'image-pull-dep-b']));
    expect(s.alreadyPresent).toBe(2);
    expect(s.repaired).toBe(0);
    expect(materializeMock).not.toHaveBeenCalled();
    expect(loadDecryptedTokenMock).not.toHaveBeenCalled(); // never decrypts needlessly
  });

  it('repairs only what is missing in a mixed set', async () => {
    const s = await reconcilePullSecrets(stubDb(ROWS), stubK8s(['image-pull-dep-a']));
    expect(s.alreadyPresent).toBe(1);
    expect(s.repaired).toBe(1);
    expect(materializeMock).toHaveBeenCalledTimes(1);
    expect(materializeMock.mock.calls[0][2]).toBe('dep-b');
  });

  it('scopes to one tenant when asked', async () => {
    const s = await reconcilePullSecrets(stubDb(ROWS), stubK8s([]), { tenantId: 't2' });
    expect(s.examined).toBe(1);
    expect(materializeMock).toHaveBeenCalledTimes(1);
    expect(materializeMock.mock.calls[0][2]).toBe('dep-b');
  });

  // One tenant's broken credential must not stop the sweep for everyone else —
  // this runs cluster-wide on an interval.
  it('keeps going after a per-row failure and reports it', async () => {
    loadDecryptedTokenMock.mockImplementation(async (_db: unknown, id: string) =>
      (id === 'dep-a' ? null : { registryHost: 'ghcr.io', username: 'u', token: 'tok' }));
    const s = await reconcilePullSecrets(stubDb(ROWS), stubK8s([]));
    expect(s.repaired).toBe(1);
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0].deploymentId).toBe('dep-a');
    expect(s.failures[0].reason).toContain('decrypted');
  });

  it('distinguishes a missing encryption key from a decrypt failure', async () => {
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    const s = await reconcilePullSecrets(stubDb(ROWS), stubK8s([]));
    expect(s.repaired).toBe(0);
    expect(s.failures).toHaveLength(2);
    expect(s.failures[0].reason).toContain('PLATFORM_ENCRYPTION_KEY');
    expect(loadDecryptedTokenMock).not.toHaveBeenCalled();
  });

  // A failure reason is logged and surfaced in the restore summary; a token
  // reaching it would be a credential leak in an operator-visible string.
  it('never puts the token in a failure reason', async () => {
    materializeMock.mockRejectedValue(new Error('boom while writing secret'));
    const s = await reconcilePullSecrets(stubDb(ROWS), stubK8s([]));
    expect(s.failures).toHaveLength(2);
    for (const f of s.failures) expect(f.reason).not.toContain('tok');
  });
});
