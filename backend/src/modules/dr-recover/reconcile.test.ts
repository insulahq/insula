import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every module the reconcile lazily imports. Dynamic `await import()`
// resolves to these mocks under vitest.
vi.mock('../k8s-provisioner/k8s-client.js', () => ({ createK8sClients: vi.fn() }));
vi.mock('../domains/k8s-ingress.js', () => ({ reconcileIngress: vi.fn() }));
vi.mock('../stalwart-jmap/client.js', () => ({ getJmapSession: vi.fn() }));
vi.mock('../email-dkim/normalize.js', () => ({ normalizeDomainDkim: vi.fn() }));
vi.mock('../deployments/service.js', () => ({ redeployWithCurrentConfig: vi.fn() }));
vi.mock('../custom-deployments/service.js', () => ({ redeployCustomDeploymentRow: vi.fn() }));

import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileIngress } from '../domains/k8s-ingress.js';
import { getJmapSession } from '../stalwart-jmap/client.js';
import { normalizeDomainDkim } from '../email-dkim/normalize.js';
import { redeployWithCurrentConfig } from '../deployments/service.js';
import { redeployCustomDeploymentRow } from '../custom-deployments/service.js';
import { tenants, emailDomains, deployments } from '../../db/schema.js';
import { reconcileRecoveredTenant } from './reconcile.js';

const k8sMock = createK8sClients as unknown as ReturnType<typeof vi.fn>;
const ingressMock = reconcileIngress as unknown as ReturnType<typeof vi.fn>;
const sessionMock = getJmapSession as unknown as ReturnType<typeof vi.fn>;
const dkimMock = normalizeDomainDkim as unknown as ReturnType<typeof vi.fn>;
const catalogRedeployMock = redeployWithCurrentConfig as unknown as ReturnType<typeof vi.fn>;
const customRedeployMock = redeployCustomDeploymentRow as unknown as ReturnType<typeof vi.fn>;

interface DomainRow { id: string; stalwartDomainId: string | null; dkimActiveSelector: string | null }
interface DepRow { id: string; source: 'catalog' | 'custom'; status: string }

function makeApp(opts: { namespace?: string | null; domains?: DomainRow[]; deps?: DepRow[] } = {}) {
  const { namespace = 'tenant-ns-1', domains = [], deps = [] } = opts;
  const updates: Array<{ patch: Record<string, unknown> }> = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === tenants) return Promise.resolve([{ namespace }]);
          if (table === emailDomains) return Promise.resolve(domains);
          if (table === deployments) return Promise.resolve(deps);
          return Promise.resolve([]);
        },
      }),
    }),
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: () => { updates.push({ patch }); return Promise.resolve(); } }) }),
  };
  return {
    db,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    config: { KUBECONFIG_PATH: '/etc/k.yaml' },
    _updates: updates,
  } as never;
}

describe('reconcileRecoveredTenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    k8sMock.mockReturnValue({ core: {}, apps: {}, custom: {} });
    ingressMock.mockResolvedValue(undefined);
    sessionMock.mockResolvedValue({ primaryAccounts: { 'urn:ietf:params:jmap:principals': 'acct-1' } });
    dkimMock.mockResolvedValue({ activeSelector: 'dkim-1', createdPublicKey: null, destroyed: [], failed: [] });
    catalogRedeployMock.mockResolvedValue(undefined);
    customRedeployMock.mockResolvedValue(undefined);
  });

  it('happy path: ingress + all domains + all workloads reconcile; only the DNS gap remains', async () => {
    const app = makeApp({
      domains: [
        { id: 'd1', stalwartDomainId: 'sw-a', dkimActiveSelector: 'dkim-1' },
        { id: 'd2', stalwartDomainId: 'sw-b', dkimActiveSelector: null },
      ],
      deps: [
        { id: 'w1', source: 'catalog', status: 'running' },
        { id: 'w2', source: 'custom', status: 'running' },
      ],
    });
    const { report, residualGaps } = await reconcileRecoveredTenant(app, 't-1');

    expect(report.ingress).toBe('reconciled');
    expect(report.mail).toEqual({ domainsTotal: 2, dkimRegenerated: 2, failed: 0 });
    expect(report.workloads).toEqual({ total: 2, redeployed: 2, failed: 0 });
    expect(catalogRedeployMock).toHaveBeenCalledOnce();
    expect(customRedeployMock).toHaveBeenCalledOnce();
    // Only the irreducible cross-cluster DNS gap remains.
    expect(residualGaps).toHaveLength(1);
    expect(residualGaps[0]).toMatch(/Cross-cluster DNS/);
  });

  it('skips ingress + workloads when the cluster clients are unavailable (mail still runs)', async () => {
    k8sMock.mockImplementation(() => { throw new Error('no kubeconfig'); });
    const app = makeApp({
      domains: [{ id: 'd1', stalwartDomainId: 'sw-a', dkimActiveSelector: null }],
      deps: [{ id: 'w1', source: 'catalog', status: 'running' }],
    });
    const { report } = await reconcileRecoveredTenant(app, 't-1');
    expect(report.ingress).toBe('skipped');
    expect(report.workloads).toEqual({ total: 0, redeployed: 0, failed: 0 });
    expect(catalogRedeployMock).not.toHaveBeenCalled();
    expect(report.mail.dkimRegenerated).toBe(1); // mail is JMAP-over-HTTP, not k8s
  });

  it('records an ingress FAILURE + gap without throwing', async () => {
    ingressMock.mockRejectedValue(new Error('traefik CRD missing'));
    const app = makeApp({ deps: [] });
    const { report, residualGaps } = await reconcileRecoveredTenant(app, 't-1');
    expect(report.ingress).toBe('failed');
    expect(residualGaps.some((g) => /Ingress rebuild failed/.test(g))).toBe(true);
  });

  it('counts a workload redeploy failure + gap, continuing the batch', async () => {
    catalogRedeployMock.mockRejectedValueOnce(new Error('ImagePullBackOff'));
    const app = makeApp({
      deps: [
        { id: 'w1', source: 'catalog', status: 'running' }, // fails
        { id: 'w2', source: 'custom', status: 'running' },  // ok
      ],
    });
    const { report, residualGaps } = await reconcileRecoveredTenant(app, 't-1');
    expect(report.workloads).toEqual({ total: 2, redeployed: 1, failed: 1 });
    expect(residualGaps.some((g) => /1\/2 workload\(s\) failed to redeploy/.test(g))).toBe(true);
  });

  it('counts a domain with a MISSING stalwartDomainId as a mail failure', async () => {
    const app = makeApp({
      domains: [
        { id: 'd1', stalwartDomainId: 'sw-a', dkimActiveSelector: null }, // ok
        { id: 'd2', stalwartDomainId: null, dkimActiveSelector: null },   // no principal → failed
      ],
    });
    const { report, residualGaps } = await reconcileRecoveredTenant(app, 't-1');
    expect(report.mail).toEqual({ domainsTotal: 2, dkimRegenerated: 1, failed: 1 });
    expect(dkimMock).toHaveBeenCalledOnce();
    expect(residualGaps.some((g) => /could not regenerate DKIM/.test(g))).toBe(true);
  });

  it('does NOT redeploy intentionally-stopped/deleting deployments', async () => {
    const app = makeApp({
      deps: [
        { id: 'w1', source: 'catalog', status: 'stopped' },
        { id: 'w2', source: 'custom', status: 'deleting' },
        { id: 'w3', source: 'catalog', status: 'running' },
      ],
    });
    const { report } = await reconcileRecoveredTenant(app, 't-1');
    expect(report.workloads.total).toBe(1); // only the running one
    expect(catalogRedeployMock).toHaveBeenCalledOnce();
    expect(customRedeployMock).not.toHaveBeenCalled();
  });

  it('persists a changed DKIM selector back to the email_domains row', async () => {
    dkimMock.mockResolvedValue({ activeSelector: 'dkim-2', createdPublicKey: 'PEM', destroyed: [], failed: [] });
    const app = makeApp({ domains: [{ id: 'd1', stalwartDomainId: 'sw-a', dkimActiveSelector: 'dkim-1' }] });
    await reconcileRecoveredTenant(app, 't-1');
    expect((app as unknown as { _updates: Array<{ patch: Record<string, unknown> }> })._updates)
      .toEqual([{ patch: { dkimActiveSelector: 'dkim-2' } }]);
  });
});
