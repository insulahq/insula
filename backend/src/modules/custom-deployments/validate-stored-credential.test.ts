import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * `POST …/custom-deployments/validate?deployment_id=` validates an edit with
 * that deployment's STORED pull credential. The deployment must be the
 * caller's tenant's: the id is on the query string, and a token must never be
 * borrowed across tenants.
 */

const { getCustomDeployment, storedProbeCredential } = vi.hoisted(() => ({
  getCustomDeployment: vi.fn(),
  storedProbeCredential: vi.fn(),
}));
vi.mock('./service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./service.js')>()),
  getCustomDeployment,
  storedProbeCredential,
}));

const { storedCredentialForValidate } = await import('./routes.js');
const app = { db: {} } as unknown as FastifyInstance;
const OWN = '11111111-2222-4333-8444-555555555555';
const CRED = { registryHost: 'ghcr.io', username: 'bot', password: 'stored' };

beforeEach(() => {
  vi.clearAllMocks();
  storedProbeCredential.mockResolvedValue(CRED);
});

describe('storedCredentialForValidate', () => {
  it('is the stored credential of the tenant’s own deployment', async () => {
    getCustomDeployment.mockResolvedValue({ id: OWN });
    expect(await storedCredentialForValidate(app, 't1', { deployment_id: OWN })).toEqual(CRED);
    expect(getCustomDeployment).toHaveBeenCalledWith(app.db, 't1', OWN);
  });

  it('refuses another tenant’s deployment before reading any token', async () => {
    getCustomDeployment.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    await expect(storedCredentialForValidate(app, 't1', { deployment_id: OWN })).rejects.toThrow('not found');
    expect(storedProbeCredential).not.toHaveBeenCalled();
  });

  it('ignores an absent or malformed id — a create is validated with what it typed', async () => {
    for (const query of [undefined, {}, { deployment_id: 'x' }, { deployment_id: [OWN] }, { deployment_id: `${OWN}' OR 1=1` }]) {
      expect(await storedCredentialForValidate(app, 't1', query)).toBeUndefined();
    }
    expect(getCustomDeployment).not.toHaveBeenCalled();
  });
});
