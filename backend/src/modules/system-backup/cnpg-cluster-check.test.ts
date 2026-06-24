import { describe, it, expect } from 'vitest';
import { assertCnpgClusterExists, CnpgClusterNotFoundError } from './cnpg-cluster-check.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function fakeK8s(impl: (a: { name: string; namespace: string }) => Promise<unknown>): K8sClients {
  return {
    custom: {
      getNamespacedCustomObject: (a: { name: string; namespace: string }) => impl(a),
    },
  } as unknown as K8sClients;
}

describe('assertCnpgClusterExists', () => {
  it('resolves when the Cluster CR exists', async () => {
    const k8s = fakeK8s(async () => ({ metadata: { name: 'system-db' } }));
    await expect(assertCnpgClusterExists(k8s, 'platform', 'system-db')).resolves.toBeUndefined();
  });

  it('queries the right group/version/plural and namespaced name', async () => {
    let seen: Record<string, unknown> | null = null;
    const k8s = {
      custom: {
        getNamespacedCustomObject: (a: Record<string, unknown>) => {
          seen = a;
          return Promise.resolve({});
        },
      },
    } as unknown as K8sClients;
    await assertCnpgClusterExists(k8s, 'platform', 'system-db');
    expect(seen).toEqual({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace: 'platform',
      plural: 'clusters',
      name: 'system-db',
    });
  });

  it('throws CnpgClusterNotFoundError on a 404 (statusCode shape)', async () => {
    const k8s = fakeK8s(async () => { throw { statusCode: 404 }; });
    await expect(assertCnpgClusterExists(k8s, 'mail', 'mail-db'))
      .rejects.toBeInstanceOf(CnpgClusterNotFoundError);
  });

  it('detects 404 from the body.code shape too', async () => {
    const k8s = fakeK8s(async () => { throw { body: { code: 404 } }; });
    await expect(assertCnpgClusterExists(k8s, 'mail', 'mail-db'))
      .rejects.toBeInstanceOf(CnpgClusterNotFoundError);
  });

  it('carries namespace + cluster on the error for the route message', async () => {
    const k8s = fakeK8s(async () => { throw { code: 404 }; });
    await expect(assertCnpgClusterExists(k8s, 'mail', 'mail-db')).rejects.toMatchObject({
      namespace: 'mail',
      cluster: 'mail-db',
    });
  });

  it('re-throws non-404 errors (RBAC/transient) rather than masking as not-found', async () => {
    const k8s = fakeK8s(async () => { throw { statusCode: 403 }; });
    await expect(assertCnpgClusterExists(k8s, 'platform', 'system-db'))
      .rejects.not.toBeInstanceOf(CnpgClusterNotFoundError);
  });
});
