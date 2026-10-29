/**
 * Keeps every tenant's sign-in gate in line with its saved routes.
 *
 * Route and provider changes reconcile the gate when they are saved, but a
 * release that changes the gate itself (its image, arguments or policy
 * format) reaches existing tenants only through a reconcile — nothing else
 * restarts their pods. So: one pass at startup, then every 10 minutes under a
 * lease. The pass is cheap when nothing changed (the config hash matches and
 * no pod rolls), and it is what retries a gate that failed to start, and
 * removes one whose last protected route went away while the API was down.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { domains, ingressAuthConfigs, ingressRoutes, tenantOauth2ProxyState, tenants } from '../../db/schema.js';
import { reconcileTenant } from './reconciler.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { safeTick } from '../../shared/safe-tick.js';

export const SIGN_IN_GATE_RECONCILE_MS = 10 * 60 * 1000;

/** Tenants with a protected route, or a gate that may still exist. */
async function gateTenants(db: Database): Promise<string[]> {
  const configured = await db.selectDistinct({ id: domains.tenantId })
    .from(ingressAuthConfigs)
    .innerJoin(ingressRoutes, eq(ingressRoutes.id, ingressAuthConfigs.ingressRouteId))
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId));
  const stateful = await db.select({ id: tenantOauth2ProxyState.tenantId }).from(tenantOauth2ProxyState);
  return [...new Set([...configured.map((r) => r.id), ...stateful.map((r) => r.id)])];
}

/**
 * `withRoutes`: rebuild the tenant's routers too (reconcileIngress, which ends
 * by reconciling the gate). Needed once per start: a release can change what
 * a protected route renders — this one moved `/oauth2/*` from a separate
 * IngressRoute into the route's own, and the gate removes the old one, so the
 * new router must exist first or sign-in breaks until the next route edit.
 */
export async function reconcileAllSignInGates(
  db: Database,
  k8s: K8sClients,
  encryptionKey: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  opts: { withRoutes?: boolean } = {},
): Promise<void> {
  const { reconcileIngress } = await import('../domains/k8s-ingress.js');
  for (const tenantId of await gateTenants(db)) {
    if (opts.withRoutes) {
      const [t] = await db.select({ ns: tenants.kubernetesNamespace }).from(tenants).where(eq(tenants.id, tenantId));
      if (t?.ns) {
        try {
          await reconcileIngress(db, k8s, tenantId, t.ns);
          continue;
        } catch (err) {
          log.warn({ tenantId, err }, '[sign-in-gate] route reconcile failed; reconciling the gate alone');
        }
      }
    }
    const out = await reconcileTenant({ db, k8s, encryptionKey }, tenantId);
    if (out.error) log.warn({ tenantId, error: out.error }, '[sign-in-gate] reconcile reported an error');
  }
}

export function startSignInGateReconciler(deps: {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly encryptionKey: string;
  readonly log: { warn: (obj: unknown, msg?: string) => void };
}): () => void {
  const { db, k8s, encryptionKey, log } = deps;
  const warn = { warn: (msg: string, err?: unknown) => log.warn({ err }, `[sign-in-gate] ${msg}`) };
  // The startup pass is a run lock (released when done), not the sticky
  // schedule owner: during a rollout the previous replicas may hold the
  // schedule, and the pass that brings routes onto this release must still run.
  const run = (withRoutes: boolean): void => safeTick(
    'sign-in-gate-reconcile',
    () => withSchedulerLease(db, 'sign-in-gate-reconcile', SIGN_IN_GATE_RECONCILE_MS * 1.5,
      () => reconcileAllSignInGates(db, k8s, encryptionKey, log, { withRoutes }),
      withRoutes ? { release: true } : {}),
    warn,
  );
  run(true);
  const timer = setInterval(() => run(false), SIGN_IN_GATE_RECONCILE_MS);
  return () => clearInterval(timer);
}
