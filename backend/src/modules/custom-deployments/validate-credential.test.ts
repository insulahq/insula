import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/index.js';

/**
 * Validate probes a private image WITH the credential, as create does.
 *
 * It used to probe anonymously whatever the tenant had configured: the panel
 * left the token out of the request "because validate is a dry run", and the
 * service never passed one on. A private image can only answer an anonymous
 * probe with 401, so every validation of one ended in IMAGE_ACCESS_DENIED —
 * with a correct token configured.
 */

const { reachable, decrypted } = vi.hoisted(() => ({
  reachable: vi.fn(async () => []),
  decrypted: vi.fn(),
}));
vi.mock('./image-reachability.js', () => ({ checkImageReachable: reachable }));
vi.mock('../system-settings/service.js', () => ({
  getSettings: vi.fn(async () => ({ customDeploymentsWarnUnpinnedTags: false, customDeploymentsAllowCompose: true })),
}));
vi.mock('./pat-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pat-store.js')>()),
  loadDecryptedToken: decrypted,
}));

const { validateSimpleSpec, storedCredentialForImage, storedProbeCredential } = await import('./service.js');

const db = {} as Database;
const input = (over: Record<string, unknown> = {}) => ({
  mode: 'simple' as const,
  name: 'private-app',
  image: 'ghcr.io/acme/private:1.0.0',
  ports: [], volumes: [], env: [],
  resources: { cpuRequest: '5m', memoryRequest: '128Mi' },
  ...over,
}) as never;
const GHCR = { registry_host: 'ghcr.io', username: 'bot', token: 'pat-123' };

beforeEach(() => vi.clearAllMocks());

describe('validateSimpleSpec', () => {
  it('probes with the credential typed into the form', async () => {
    await validateSimpleSpec(db, input({ pull_credential: GHCR }), { role: 'tenant_admin' });
    expect(reachable).toHaveBeenCalledWith('ghcr.io/acme/private:1.0.0', 'services.private-app.image', { username: 'bot', password: 'pat-123' });
  });

  it('probes with the deployment’s stored credential when an edit is validated', async () => {
    await validateSimpleSpec(db, input(), { role: 'tenant_admin' }, { registryHost: 'ghcr.io', username: 'bot', password: 'stored' });
    expect(reachable).toHaveBeenCalledWith(expect.any(String), expect.any(String), { username: 'bot', password: 'stored' });
  });

  it('never sends a credential to another registry', async () => {
    await validateSimpleSpec(db, input({ image: 'redis:7', pull_credential: GHCR }), { role: 'tenant_admin' });
    expect(reachable).toHaveBeenCalledWith('redis:7', expect.any(String), undefined);
  });

  it('probes anonymously with no credential at all', async () => {
    await validateSimpleSpec(db, input(), { role: 'tenant_admin' });
    expect(reachable).toHaveBeenCalledWith(expect.any(String), expect.any(String), undefined);
  });
});

describe('storedCredentialForImage', () => {
  it('is the stored token for an image on its registry', async () => {
    decrypted.mockResolvedValueOnce({ registryHost: 'ghcr.io', username: 'bot', token: 'pat-123' });
    expect(await storedCredentialForImage(db, 'd1', 'ghcr.io/acme/private:1', 'k')).toEqual({ username: 'bot', password: 'pat-123' });
  });

  it('is nothing for an image on another registry — the probe answers that registry’s auth realm', async () => {
    decrypted.mockResolvedValueOnce({ registryHost: 'ghcr.io', username: 'bot', token: 'pat-123' });
    expect(await storedCredentialForImage(db, 'd1', 'docker.io/library/redis:7', 'k')).toBeUndefined();
  });

  it('is nothing without the encryption key, and never asks the store', async () => {
    expect(await storedCredentialForImage(db, 'd1', 'ghcr.io/acme/private:1', undefined)).toBeUndefined();
    expect(decrypted).not.toHaveBeenCalled();
  });

  it('degrades to anonymous when the stored token cannot be decrypted', async () => {
    decrypted.mockRejectedValueOnce(new Error('PAT_DECRYPT_FAILED'));
    expect(await storedProbeCredential(db, 'd1', 'k')).toBeUndefined();
  });
});
