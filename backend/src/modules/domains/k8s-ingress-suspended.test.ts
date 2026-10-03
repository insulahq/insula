/**
 * reconcileIngress must not undo a tenant suspension.
 *
 * Suspension lives only on the live IngressRoutes (marker annotation + a
 * redirect Middleware reference, tenant-lifecycle/ingress-suspend.ts); the
 * reconciler rebuilds every IngressRoute from ingress_routes and writes it as
 * a full replace. Without the guard, any reconcile in the suspend window —
 * a certificate issuing, the bandwidth meter, the verification cron — put a
 * suspended tenant's sites back online.
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

/** A tenant with no domains: the reconcile's whole job is to delete its IngressRoute. */
function makeDb() {
  const builder: Record<string, unknown> = {};
  builder.from = () => builder;
  builder.where = () => Promise.resolve([]);
  const select = vi.fn(() => builder);
  return { db: { select } as never, select };
}

describe('reconcileIngress — suspended tenants', () => {
  it('leaves a suspended namespace untouched: no reads of routes, no writes, no deletes', async () => {
    const { k8s, custom } = makeK8s({ 'platform.io/suspended': 'true' });
    const { db, select } = makeDb();
    await reconcileIngress(db, k8s, 't1', NS);
    expect(select).not.toHaveBeenCalled();
    expect(custom.replaceNamespacedCustomObject).not.toHaveBeenCalled();
    expect(custom.createNamespacedCustomObject).not.toHaveBeenCalled();
    expect(custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('reconciles normally when no IngressRoute carries the suspend marker', async () => {
    const { k8s, custom } = makeK8s({ 'hosting-platform/route-id': 'r1' });
    const { db, select } = makeDb();
    await reconcileIngress(db, k8s, 't1', NS);
    expect(select).toHaveBeenCalled();
    // No domains → the tenant IngressRoute is deleted: proof the write path ran.
    expect(custom.deleteNamespacedCustomObject).toHaveBeenCalled();
  });

  it('a marker set to anything but "true" does not count as suspended', async () => {
    const { k8s, custom } = makeK8s({ 'platform.io/suspended': 'false' });
    const { db } = makeDb();
    await reconcileIngress(db, k8s, 't1', NS);
    expect(custom.deleteNamespacedCustomObject).toHaveBeenCalled();
  });
});
