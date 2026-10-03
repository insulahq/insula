/**
 * A tenant IngressRoute built before its certificate existed carries no
 * tls.secretName, so Traefik serves its default certificate for the host. The
 * certificate going Ready changes nothing by itself. The reconciler is the one
 * place that sees issuance happen, so on a FIRST issuance it rebuilds that
 * tenant's ingress (v2026.10.3-rc.2 VM run, staging-all https: Certificate
 * Ready after 20 s, default cert served for the next 60 s and beyond).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CertificateHealth } from './status.js';

vi.mock('../notifications/events.js', () => ({
  notifyAdminCertCheckUnavailable: vi.fn(),
  notifyAdminCertCheckResumed: vi.fn(),
  notifyAdminCertRenewalFailed: vi.fn(),
  notifyAdminCertIssuanceFailed: vi.fn(),
  notifyAdminCertRecovered: vi.fn(),
  notifyAdminCertExpiring: vi.fn(),
  notifyTenantCertificateFailed: vi.fn(),
  notifyTenantCertificateIssued: vi.fn(),
  notifyTenantCertificateFallback: vi.fn(),
}));

let healthByNamespace: Record<string, CertificateHealth[]> = {};
vi.mock('./status.js', () => ({
  listCertificateHealth: vi.fn(async (_k8s: unknown, ns: string) => healthByNamespace[ns] ?? []),
  shouldFallBack: () => false,
}));

vi.mock('./acme-challenges.js', () => ({
  createWedgeMemory: () => ({ observe: () => 0, forget: () => undefined }),
  clearWedgedChallenges: vi.fn(async () => ({ cleared: 0, errors: [] })),
}));

const { reconcileCertificateStatuses, __resetSweepAvailabilityForTests } = await import('./cert-reconciler.js');

interface DomainFixture { domainId: string; domainName: string; tenantId: string; namespace: string }

/** `stored` is the ssl_certificates row the reconciler reads per domain. */
function fakeDb(domains: DomainFixture[], stored: Array<Record<string, unknown>>) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => Promise.resolve(domains) }),
        where: () => Promise.resolve(stored),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: () => ({ values: () => Promise.resolve() }),
  } as never;
}

/** Secrets are not what this test is about: every read is a 404. */
const k8s = {
  core: { readNamespacedSecret: vi.fn(async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); }) },
  custom: {},
} as never;

function health(domainId: string, domainName: string, state: CertificateHealth['state']): CertificateHealth {
  return { name: `${domainName}-cert`, domainId, state, dnsNames: [domainName], failedAttempts: 0, wildcard: false };
}

const A: DomainFixture = { domainId: 'd1', domainName: 'a.example.test', tenantId: 't1', namespace: 'tenant-a' };
const B: DomainFixture = { domainId: 'd2', domainName: 'b.example.test', tenantId: 't1', namespace: 'tenant-a' };

beforeEach(() => {
  healthByNamespace = {};
  __resetSweepAvailabilityForTests();
});

describe('certificate reconciler — ingress refresh on first issuance', () => {
  it('rebuilds the tenant ingress when a never-issued certificate is now issued', async () => {
    healthByNamespace = { 'tenant-a': [health('d1', A.domainName, 'issued')] };
    const reconcileIngress = vi.fn(async () => undefined);
    const db = fakeDb([A], []);
    const result = await reconcileCertificateStatuses(db, k8s, { reconcileIngress });
    expect(reconcileIngress).toHaveBeenCalledTimes(1);
    expect(reconcileIngress).toHaveBeenCalledWith(db, k8s, 't1', 'tenant-a');
    expect(result.ingressRefreshed).toBe(1);
  });

  it('a row that was issued before — never re-issued, so no rebuild (steady state costs nothing)', async () => {
    healthByNamespace = { 'tenant-a': [health('d1', A.domainName, 'issued')] };
    const reconcileIngress = vi.fn(async () => undefined);
    await reconcileCertificateStatuses(
      fakeDb([A], [{ id: 'c1', status: 'issued', lastIssuedAt: new Date('2026-09-01T00:00:00Z') }]),
      k8s,
      { reconcileIngress },
    );
    expect(reconcileIngress).not.toHaveBeenCalled();
  });

  it('a certificate still pending — nothing to stamp in yet', async () => {
    healthByNamespace = { 'tenant-a': [health('d1', A.domainName, 'pending')] };
    const reconcileIngress = vi.fn(async () => undefined);
    await reconcileCertificateStatuses(fakeDb([A], []), k8s, { reconcileIngress });
    expect(reconcileIngress).not.toHaveBeenCalled();
  });

  it('two domains of one tenant issuing together rebuild that tenant once', async () => {
    healthByNamespace = { 'tenant-a': [health('d1', A.domainName, 'issued'), health('d2', B.domainName, 'issued')] };
    const reconcileIngress = vi.fn(async () => undefined);
    await reconcileCertificateStatuses(fakeDb([A, B], []), k8s, { reconcileIngress });
    expect(reconcileIngress).toHaveBeenCalledTimes(1);
  });

  it('a failed rebuild is reported in errors, not thrown — the sweep must finish', async () => {
    healthByNamespace = { 'tenant-a': [health('d1', A.domainName, 'issued')] };
    const reconcileIngress = vi.fn(async () => { throw new Error('apiserver timeout'); });
    const result = await reconcileCertificateStatuses(fakeDb([A], []), k8s, { reconcileIngress });
    expect(result.ingressRefreshed).toBe(0);
    expect(result.errors.some((e) => e.includes('apiserver timeout'))).toBe(true);
  });
});
