/**
 * reconcileIngress must not undo a tenant suspension — and must not wedge a
 * resumed tenant either.
 *
 * Suspension lives on the live IngressRoutes (marker annotation + a redirect
 * Middleware reference, tenant-lifecycle/ingress-suspend.ts); the reconciler
 * rebuilds every IngressRoute from ingress_routes as a full replace. Without
 * a guard, any reconcile in the suspend window — a certificate issuing, the
 * bandwidth meter, the verification cron — put a suspended tenant's sites
 * back online. The guard reads tenants.status (stamped BEFORE the ingress
 * hooks run), so a stale marker on an ACTIVE tenant is rebuilt away instead
 * of blocking every reconcile forever.
 */
import { describe, it, expect, vi } from 'vitest';
import { reconcileIngress } from './k8s-ingress.js';

const NS = 'tenant-acme';

function makeK8s(routeAnnotations: Record<string, string> | null) {
  const custom = {
    listNamespacedCustomObject: vi.fn(async (args: { plural: string }) => ({
      items: args.plural === 'ingressroutes' && routeAnnotations
        ? [{ metadata: { name: `${NS}-ingress`, namespace: NS, annotations: routeAnnotations } }]
        : [],
    })),
    createNamespacedCustomObject: vi.fn(async () => ({})),
    replaceNamespacedCustomObject: vi.fn(async () => ({})),
    deleteNamespacedCustomObject: vi.fn(async () => ({})),
    getNamespacedCustomObject: vi.fn(async () => { throw Object.assign(new Error('nf'), { code: 404, statusCode: 404 }); }),
  };
  return { k8s: { custom, core: {}, apps: {}, networking: {} } as never, custom };
}

/**
 * First select = the tenant's status; everything after = no domains (so the
 * reconcile's whole job is to delete the tenant IngressRoute — a visible write).
 */
function makeDb(status: string | undefined) {
  let call = 0;
  const select = vi.fn(() => {
    const first = call++ === 0;
    const builder: Record<string, unknown> = {};
    builder.from = () => builder;
    builder.where = () => Promise.resolve(first && status ? [{ status }] : []);
    return builder;
  });
  return { db: { select } as never, select };
}

describe('reconcileIngress — suspended tenants', () => {
  it('leaves a suspended tenant untouched: no route reads, no writes, no deletes', async () => {
    const { k8s, custom } = makeK8s({ 'platform.io/suspended': 'true' });
    const { db, select } = makeDb('suspended');
    await reconcileIngress(db, k8s, 't1', NS);
    expect(select).toHaveBeenCalledTimes(1); // the status read, nothing more
    expect(custom.replaceNamespacedCustomObject).not.toHaveBeenCalled();
    expect(custom.createNamespacedCustomObject).not.toHaveBeenCalled();
    expect(custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('a suspended tenant whose suspend hook has not marked the routes yet is still left alone', async () => {
    const { k8s, custom } = makeK8s(null);
    const { db } = makeDb('suspended');
    await reconcileIngress(db, k8s, 't1', NS);
    expect(custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('an ACTIVE tenant with a leftover suspend marker (partial resume) is rebuilt, which heals it', async () => {
    const { k8s, custom } = makeK8s({ 'platform.io/suspended': 'true' });
    const { db } = makeDb('active');
    await reconcileIngress(db, k8s, 't1', NS);
    expect(custom.deleteNamespacedCustomObject).toHaveBeenCalled();
  });

  it('an active tenant reconciles normally', async () => {
    const { k8s, custom } = makeK8s({ 'hosting-platform/route-id': 'r1' });
    const { db, select } = makeDb('active');
    await reconcileIngress(db, k8s, 't1', NS);
    expect(select.mock.calls.length).toBeGreaterThan(1);
    expect(custom.deleteNamespacedCustomObject).toHaveBeenCalled();
  });
});
