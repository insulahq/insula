import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRotate = vi.fn(async () => ({}));
vi.mock('./rotate-jmap.js', () => ({
  rotateAdminPasswordViaJmap: (...args: unknown[]) => mockRotate(...args),
}));

const mockVerify = vi.fn();
vi.mock('../stalwart-jmap/client.js', () => ({
  verifyMasterJmapAuth: (...args: unknown[]) => mockVerify(...args),
}));

const mockReadUser = vi.fn(async () => 'master@local.host');
const mockReadPw = vi.fn(async () => 'secret-pw');
vi.mock('./stalwart-master-user.js', () => ({
  readStalwartMasterUser: (...a: unknown[]) => mockReadUser(...a),
  readStalwartMasterPassword: (...a: unknown[]) => mockReadPw(...a),
  MASTER_SENTINEL_DOMAIN: 'local.host',
  MASTER_USER_KEY: 'STALWART_MASTER_USER',
  MAIL_SECRET_NAMESPACE: 'mail',
  MAIL_SECRET_NAME: 'mail-secrets',
}));

const { reconcileStalwartMasterCredential } = await import('./reconcile-master-credential.js');
const fakeCore = {} as never;

describe('reconcileStalwartMasterCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadUser.mockResolvedValue('master@local.host');
    mockReadPw.mockResolvedValue('secret-pw');
  });

  it('no-ops (no mutation) when the master already authenticates', async () => {
    mockVerify.mockResolvedValue({ ok: true, status: 200 });
    const r = await reconcileStalwartMasterCredential({ core: fakeCore });
    expect(r.status).toBe('ok');
    expect(r.healed).toBe(false);
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('re-asserts the EXISTING mail-secrets password when the master cannot authenticate', async () => {
    mockVerify
      .mockResolvedValueOnce({ ok: false, status: 401 }) // drift detected
      .mockResolvedValueOnce({ ok: true, status: 200 }); // converged after re-assert
    const r = await reconcileStalwartMasterCredential({ core: fakeCore });
    expect(r.status).toBe('healed');
    expect(r.healed).toBe(true);
    expect(mockRotate).toHaveBeenCalledTimes(1);
    // Converges to the existing secret (explicitPassword) — NOT a new password —
    // recreating the account with Admin role if it was wiped.
    expect(mockRotate.mock.calls[0][0]).toMatchObject({
      explicitPassword: 'secret-pw',
      username: 'master',
      principalDomain: 'local.host',
      autoReseed: true,
      principalRoles: { '@type': 'Admin' },
      secretKeys: ['STALWART_MASTER_PASSWORD'],
    });
  });

  it('skips (no mutation) when mail-secrets has no master password', async () => {
    mockReadPw.mockResolvedValue(null);
    const r = await reconcileStalwartMasterCredential({ core: fakeCore });
    expect(r.status).toBe('skipped');
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('skips (no mutation) on a transient/non-auth probe error — never mutate on an unclear signal', async () => {
    mockVerify.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await reconcileStalwartMasterCredential({ core: fakeCore });
    expect(r.status).toBe('skipped');
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('reports failed when the re-assert does not converge', async () => {
    mockVerify
      .mockResolvedValueOnce({ ok: false, status: 401 }) // drift
      .mockResolvedValueOnce({ ok: false, status: 401 }); // still broken after re-assert
    const r = await reconcileStalwartMasterCredential({ core: fakeCore });
    expect(r.status).toBe('failed');
    expect(r.healed).toBe(false);
  });

  it('skips when there is no k8s client', async () => {
    const r = await reconcileStalwartMasterCredential({ core: null });
    expect(r.status).toBe('skipped');
    expect(mockRotate).not.toHaveBeenCalled();
  });
});
