/**
 * Bring already-running multi-host deployments onto the isolated mount layout.
 *
 * The isolation this platform now promises is applied when a pod template is
 * built. That leaves a gap the security fix itself cannot close: an instance
 * deployed before it, which nobody touches again, keeps the OLD layout —
 * the whole tenant volume mounted at `sites_root`, and (for instances created
 * while the catalog carried a blank default) `PHP_DISABLE_FUNCTIONS` empty, so
 * `shell_exec` still reaches every sibling site.
 *
 * Nothing else would fix those. `ensureSiteMounts` only runs when a route
 * changes, and there is no periodic multi-host reconcile — so an untouched
 * deployment would stay exposed indefinitely while the changelog said the
 * problem was fixed. That gap between the claim and the deployed state is the
 * reason this exists.
 *
 * Deliberately a redeploy rather than a mount patch: the disarmed hardening
 * lives in the pod's ENV, which only a rebuilt template carries.
 */
import { eq, and, ne } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { deployments, catalogEntries, tenants } from '../../db/schema.js';
import { capabilityOf } from '../multihost/reconciler.js';
import { MULTIHOST_DISABLED_PHP_FUNCTIONS } from './k8s-deployer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

export interface RemediationReport {
  readonly scanned: number;
  readonly remediated: string[];
  readonly failed: Array<{ deployment: string; error: string }>;
  /** Deployments we could not inspect — NOT the same as "nothing to do". */
  readonly unreadable: string[];
  /** Rows whose workload was absent. A sweep where this equals `scanned`
   *  examined nothing, however clean the rest of the report looks. */
  readonly notFound: string[];
}

/**
 * Does this live pod template still carry the pre-fix exposure?
 *
 * Two independent symptoms, either of which is enough:
 *  - a mount of `sites_root` with no subPath — the whole tenant volume;
 *  - a container missing the hardening baseline, so exec is available on a pod
 *    that can see more than its own site.
 */
export function needsRemediation(
  podSpec: { containers?: Array<Record<string, unknown>> } | undefined,
  sitesRoot: string,
): boolean {
  const containers = podSpec?.containers ?? [];
  for (const c of containers) {
    const mounts = (c.volumeMounts ?? []) as Array<Record<string, unknown>>;
    if (mounts.some((m) => m.mountPath === sitesRoot && !m.subPath)) return true;

    // Only the container that actually serves sites carries the hardening, so
    // a container with no site mounts is not evidence of anything.
    const servesSites = mounts.some((m) => String(m.mountPath ?? '').startsWith(`${sitesRoot}/`));
    if (!servesSites) continue;
    const env = (c.env ?? []) as Array<{ name?: string; value?: string }>;
    const disabled = env.find((e) => e.name === 'PHP_DISABLE_FUNCTIONS')?.value ?? '';
    const have = new Set(disabled.split(',').map((f) => f.trim()).filter(Boolean));
    if (MULTIHOST_DISABLED_PHP_FUNCTIONS.split(',').some((fn) => !have.has(fn))) return true;
  }
  return false;
}

export async function remediateMultihostDeployments(
  db: Db,
  k8s: K8sClients,
  redeploy: (db: Db, deployment: typeof deployments.$inferSelect, k8s: K8sClients) => Promise<unknown>,
  logger?: Logger,
): Promise<RemediationReport> {
  // The namespace comes from the TENANT ROW, never from the tenant id.
  // Composing `tenant-${tenantId}` produced a namespace that does not exist,
  // every lookup 404'd, and 404 is treated as "no workload, nothing to do" —
  // so this swept nothing and reported every instance already isolated. A
  // safety net that cannot fail is a safety net that never ran.
  const rows = await db
    .select({ dep: deployments, entry: catalogEntries, namespace: tenants.kubernetesNamespace })
    .from(deployments)
    .leftJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
    .leftJoin(tenants, eq(deployments.tenantId, tenants.id))
    .where(and(eq(deployments.multihostEnabled, true), ne(deployments.status, 'deleted')));

  const remediated: string[] = [];
  const failed: Array<{ deployment: string; error: string }> = [];
  const unreadable: string[] = [];
  const notFound: string[] = [];

  for (const row of rows as Array<{
    dep: typeof deployments.$inferSelect;
    entry: typeof catalogEntries.$inferSelect | null;
    namespace: string | null;
  }>) {
    const cap = capabilityOf(row.entry ?? undefined);
    if (!cap) continue;
    const namespace = row.namespace;
    if (!namespace) { unreadable.push(row.dep.name); continue; }
    try {
      const live = await k8s.apps.readNamespacedDeployment({ name: row.dep.name, namespace } as never) as {
        spec?: { template?: { spec?: { containers?: Array<Record<string, unknown>> } } };
      };
      if (!needsRemediation(live.spec?.template?.spec, cap.sites_root)) continue;
      logger?.warn(
        { deployment: row.dep.name, namespace },
        'multihost: instance is on the pre-isolation layout — redeploying onto per-folder mounts',
      );
      await redeploy(db, row.dep, k8s);
      remediated.push(row.dep.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A 404 is a deployment row with no workload. Counted, not silent: when
      // the namespace was being composed wrongly, EVERY lookup 404'd and the
      // sweep reported a clean result having examined nothing.
      const status = (err as { statusCode?: number; code?: number }).statusCode ?? (err as { code?: number }).code;
      if (status === 404) { notFound.push(row.dep.name); continue; }
      // Report what we could not inspect. Counting it as "fine" is how a sweep
      // that failed on every instance reports a clean run.
      unreadable.push(row.dep.name);
      failed.push({ deployment: row.dep.name, error: msg });
      logger?.error({ err, deployment: row.dep.name }, 'multihost: remediation failed');
    }
  }
  return { scanned: rows.length, remediated, failed, unreadable, notFound };
}
