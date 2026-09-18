/**
 * What the certificate reconciler is allowed to TELL an operator.
 *
 * Written from a real failure: a brief Kubernetes API blackout produced one
 * notification PER DOMAIN inside a single second — dozens of them, every one
 * titled "Cert renewal failed", not one of them true. Nothing had failed to
 * renew; every certificate was Ready with weeks left. The reconciler had
 * simply been unable to READ the Secrets, and its per-domain catch reported
 * that as a renewal failure, with no dedupe key to collapse it.
 *
 * The four properties asserted here are exactly the four faults:
 *   1. an unreachable dependency notifies ONCE, not once per subject;
 *   2. a single blip notifies not at all (it must outlive one retry);
 *   3. the message names the dependency instead of quoting "fetch failed";
 *   4. a failure that clears is announced, so an alarm has a closing half.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const notify = {
  unavailable: vi.fn(),
  resumed: vi.fn(),
  renewalFailed: vi.fn(),
  issuanceFailed: vi.fn(),
  recovered: vi.fn(),
  tenantFailed: vi.fn(),
  tenantIssued: vi.fn(),
  tenantFallback: vi.fn(),
  expiring: vi.fn(),
};

vi.mock('../notifications/events.js', () => ({
  notifyAdminCertCheckUnavailable: (...a: unknown[]) => notify.unavailable(...a),
  notifyAdminCertCheckResumed: (...a: unknown[]) => notify.resumed(...a),
  notifyAdminCertRenewalFailed: (...a: unknown[]) => notify.renewalFailed(...a),
  notifyAdminCertIssuanceFailed: (...a: unknown[]) => notify.issuanceFailed(...a),
  notifyAdminCertRecovered: (...a: unknown[]) => notify.recovered(...a),
  notifyAdminCertExpiring: (...a: unknown[]) => notify.expiring(...a),
  notifyTenantCertificateFailed: (...a: unknown[]) => notify.tenantFailed(...a),
  notifyTenantCertificateIssued: (...a: unknown[]) => notify.tenantIssued(...a),
  notifyTenantCertificateFallback: (...a: unknown[]) => notify.tenantFallback(...a),
}));

// The sweep lists cert-manager health per namespace; every test here drives the
// Secret read, so health is stubbed as "nothing known about this domain".
vi.mock('./status.js', () => ({
  listCertificateHealth: vi.fn(async () => []),
  shouldFallBack: () => false,
}));

vi.mock('./acme-challenges.js', () => ({
  createWedgeMemory: () => ({ observe: () => 0, forget: () => undefined }),
  clearWedgedChallenges: vi.fn(async () => ({ cleared: 0, errors: [] })),
}));

const { reconcileCertificateStatuses, __resetSweepAvailabilityForTests } = await import(
  './cert-reconciler.js'
);

/** 29 domains, the production count, so a fan-out is unmistakable in the numbers. */
const DOMAINS = Array.from({ length: 29 }, (_, i) => ({
  domainId: `d${i}`,
  domainName: `site${i}.example.test`,
  tenantId: `t${i}`,
  namespace: 'tenant-ns',
}));

function fakeDb(domains = DOMAINS) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => Promise.resolve(domains) }),
        where: () => Promise.resolve([]),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: () => ({ values: () => Promise.resolve() }),
  } as never;
}

/** A K8s client whose every Secret read fails the way undici reports a dead API. */
function unreachableK8s() {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
  return {
    core: { readNamespacedSecret: vi.fn(async () => { throw err; }) },
    custom: { listNamespacedCustomObject: vi.fn(async () => { throw err; }) },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSweepAvailabilityForTests();
});

describe('an unreachable Kubernetes API', () => {
  it('never reports a renewal failure — it could not read anything', async () => {
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    // The exact production symptom: 29 of these.
    expect(notify.renewalFailed).not.toHaveBeenCalled();
    expect(notify.issuanceFailed).not.toHaveBeenCalled();
    expect(notify.tenantFailed).not.toHaveBeenCalled();
  });

  it('says nothing at all on the first failed sweep', async () => {
    // The outage that caused all this lasted 21 seconds. The reconciler runs
    // every 60, so the next sweep had already recovered before anyone could
    // have read a notification.
    const result = await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    expect(result.unreachable).not.toBeNull();
    expect(notify.unavailable).not.toHaveBeenCalled();
  });

  it('raises exactly ONE alarm when it survives a retry', async () => {
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    expect(notify.unavailable).toHaveBeenCalledTimes(1);

    // ...and stays quiet while the outage continues, rather than alarming once
    // a minute for its duration.
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    expect(notify.unavailable).toHaveBeenCalledTimes(1);
  });

  it('names the dependency and carries a dedupe key', async () => {
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    const [, payload, dedupeKey] = notify.unavailable.mock.calls[0] as [
      unknown, Record<string, string>, string,
    ];
    expect(payload.dependency).toMatch(/Kubernetes API/i);
    // The count of what is UNKNOWN, not a verdict on each domain.
    expect(payload.uncheckedCount).toBe('29');
    expect(dedupeKey).toMatch(/^cert-check-unavailable:\d{4}-\d{2}-\d{2}$/);
    // "fetch failed" may appear as quoted evidence, but never as the whole
    // explanation: the operator must be told what could not be reached.
    expect(payload.recommendedAction).toMatch(/connectivity/i);
  });

  it('abandons the sweep instead of retrying all 29 domains against a dead API', async () => {
    const k8s = unreachableK8s();
    await reconcileCertificateStatuses(fakeDb(), k8s);
    const reads = (k8s as unknown as { core: { readNamespacedSecret: { mock: { calls: unknown[] } } } })
      .core.readNamespacedSecret.mock.calls.length;
    // Both bounds matter. `> 0` is the non-vacuity check: if the sweep never
    // reached a Secret read at all, "fewer than 29 reads" would pass while
    // proving nothing. Measured: 1 read with the fix, 29 without it.
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(DOMAINS.length);
  });

  it('closes the alarm when the API answers again', async () => {
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    await reconcileCertificateStatuses(fakeDb(), unreachableK8s());
    expect(notify.unavailable).toHaveBeenCalledTimes(1);

    const healthy = {
      core: { readNamespacedSecret: vi.fn(async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); }) },
      custom: { listNamespacedCustomObject: vi.fn(async () => ({ items: [] })) },
    } as never;
    await reconcileCertificateStatuses(fakeDb(), healthy);
    expect(notify.resumed).toHaveBeenCalledTimes(1);
    const [, payload] = notify.resumed.mock.calls[0] as [unknown, Record<string, string>];
    expect(payload.outageLabel).toBeTruthy();
  });

  it('does NOT close an alarm it never raised', async () => {
    // The control for the test above: a resumed notice with no preceding
    // warning is noise, and would fire on every boot.
    const healthy = {
      core: { readNamespacedSecret: vi.fn(async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); }) },
      custom: { listNamespacedCustomObject: vi.fn(async () => ({ items: [] })) },
    } as never;
    await reconcileCertificateStatuses(fakeDb(), healthy);
    expect(notify.resumed).not.toHaveBeenCalled();
  });
});

describe('a per-domain failure is still reported', () => {
  it('an error that is NOT a transport failure does not abandon the sweep', async () => {
    // The control for "abandons the sweep": a malformed certificate on one
    // domain must not stop the other 28 from being checked. Silencing
    // everything would pass every test above.
    const err = Object.assign(new Error('secrets is forbidden'), { statusCode: 403 });
    const k8s = {
      core: { readNamespacedSecret: vi.fn(async () => { throw err; }) },
      custom: { listNamespacedCustomObject: vi.fn(async () => ({ items: [] })) },
    } as never;
    const result = await reconcileCertificateStatuses(fakeDb(), k8s);
    expect(result.unreachable).toBeNull();
    expect(result.errors.length).toBe(DOMAINS.length);
    // Reported in the log, not as a renewal failure notification.
    expect(notify.renewalFailed).not.toHaveBeenCalled();
  });
});
