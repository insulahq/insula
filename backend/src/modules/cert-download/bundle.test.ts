import { describe, it, expect, vi } from 'vitest';
import { buildCertBundle, type DomainRef } from './bundle.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

vi.mock('../oidc/crypto.js', () => ({
  decrypt: (ct: string) => {
    if (ct === 'UNDECRYPTABLE') throw new Error('bad key');
    return ct.replace('enc:', '');
  },
}));

const KEY = '0'.repeat(64);
const DOMAIN: DomainRef = {
  domainId: 'd-1', tenantId: 't-1', domainName: 'example.test', namespace: 'tenant-ns',
};

const MANAGED_CRT = '-----BEGIN CERTIFICATE-----\nMANAGED\n-----END CERTIFICATE-----';
const MANAGED_KEY = '-----BEGIN PRIVATE KEY-----\nMANAGEDKEY\n-----END PRIVATE KEY-----';

/** k8s stub: `secrets` maps secret name -> {tls.crt, tls.key} (already base64). */
function k8sWith(secrets: Record<string, { crt: string; key: string }>): K8sClients {
  return {
    core: {
      readNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
        const s = secrets[name];
        if (!s) throw Object.assign(new Error('nf'), { statusCode: 404 });
        return {
          data: {
            'tls.crt': Buffer.from(s.crt).toString('base64'),
            'tls.key': Buffer.from(s.key).toString('base64'),
          },
        };
      }),
    },
  } as unknown as K8sClients;
}

/** db stub returning the given ssl_certificates rows. */
function dbWith(rows: unknown[]): Database {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) }),
  } as unknown as Database;
}

describe('buildCertBundle', () => {
  it('returns the cert-manager bundle when the wildcard Secret exists', async () => {
    const k8s = k8sWith({ 'example-test-wildcard-tls': { crt: MANAGED_CRT, key: MANAGED_KEY } });
    const bundle = await buildCertBundle(dbWith([]), k8s, DOMAIN, KEY);

    expect(bundle?.source).toBe('managed');
    expect(bundle?.pem).toContain('MANAGED');
    expect(bundle?.pem).toContain('MANAGEDKEY');
  });

  it('falls back to the per-hostname Secret when there is no wildcard (HTTP-01 mode)', async () => {
    const k8s = k8sWith({ 'example-test-tls': { crt: MANAGED_CRT, key: MANAGED_KEY } });
    const bundle = await buildCertBundle(dbWith([]), k8s, DOMAIN, KEY);
    expect(bundle?.source).toBe('managed');
  });

  // Key first: nginx, apache and haproxy all accept key-then-cert and it is
  // what certbot writes, so the downloaded file drops straight in.
  it('orders the bundle private key FIRST, then the certificate', async () => {
    const k8s = k8sWith({ 'example-test-wildcard-tls': { crt: MANAGED_CRT, key: MANAGED_KEY } });
    const bundle = await buildCertBundle(dbWith([]), k8s, DOMAIN, KEY);
    expect(bundle!.pem.indexOf('PRIVATE KEY')).toBeLessThan(bundle!.pem.indexOf('CERTIFICATE'));
  });

  it('uses the uploaded certificate when there is no managed Secret', async () => {
    const db = dbWith([{
      certificate: '-----BEGIN CERTIFICATE-----\nUPLOADED\n-----END CERTIFICATE-----',
      privateKeyEncrypted: 'enc:-----BEGIN PRIVATE KEY-----\nUPKEY\n-----END PRIVATE KEY-----',
      caBundle: '-----BEGIN CERTIFICATE-----\nCHAIN\n-----END CERTIFICATE-----',
      expiresAt: new Date('2027-01-01'),
    }]);
    const bundle = await buildCertBundle(db, k8sWith({}), DOMAIN, KEY);

    expect(bundle?.source).toBe('uploaded');
    expect(bundle?.pem).toContain('UPKEY');
    expect(bundle?.pem).toContain('UPLOADED');
    // The CA chain is appended so the file is a complete bundle.
    expect(bundle?.pem).toContain('CHAIN');
    expect(bundle?.expiresAt).toEqual(new Date('2027-01-01'));
  });

  // The managed Secret is what the ingress actually serves; an uploaded row can
  // be a stale staging artefact.
  it('prefers the managed Secret over an uploaded row when both exist', async () => {
    const db = dbWith([{
      certificate: 'UPLOADED', privateKeyEncrypted: 'enc:UPKEY', caBundle: null, expiresAt: null,
    }]);
    const k8s = k8sWith({ 'example-test-wildcard-tls': { crt: MANAGED_CRT, key: MANAGED_KEY } });
    const bundle = await buildCertBundle(db, k8s, DOMAIN, KEY);
    expect(bundle?.source).toBe('managed');
  });

  it('returns null when the domain has no certificate at all', async () => {
    expect(await buildCertBundle(dbWith([]), k8sWith({}), DOMAIN, KEY)).toBeNull();
  });

  // Handing out a certificate with an unusable key would look like success and
  // fail confusingly on the customer's server.
  it('returns null rather than a keyless bundle when the key cannot be decrypted', async () => {
    const db = dbWith([{
      certificate: 'UPLOADED', privateKeyEncrypted: 'UNDECRYPTABLE', caBundle: null, expiresAt: null,
    }]);
    expect(await buildCertBundle(db, k8sWith({}), DOMAIN, KEY)).toBeNull();
  });

  it('falls back to the uploaded row when k8s is unavailable', async () => {
    const db = dbWith([{
      certificate: 'UPLOADED', privateKeyEncrypted: 'enc:UPKEY', caBundle: null, expiresAt: null,
    }]);
    const bundle = await buildCertBundle(db, null, DOMAIN, KEY);
    expect(bundle?.source).toBe('uploaded');
  });

  it('skips a Secret that is missing tls.key rather than emitting a key-less bundle', async () => {
    const k8s = {
      core: {
        readNamespacedSecret: vi.fn(async () => ({
          data: { 'tls.crt': Buffer.from(MANAGED_CRT).toString('base64') },
        })),
      },
    } as unknown as K8sClients;
    expect(await buildCertBundle(dbWith([]), k8s, DOMAIN, KEY)).toBeNull();
  });
});
