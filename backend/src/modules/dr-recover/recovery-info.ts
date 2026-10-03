/**
 * What a Recover Tenant would restore — the tenant and its bundles.
 *
 * The operator chooses a bundle by when it was taken and what it holds, not
 * by an id they would have to look up; and before restoring a tenant they see
 * what it was: plan, storage tier, node, namespace (and whether it still
 * exists), resources.
 *
 * A live tenant answers from its row. A DELETED tenant has no row any more:
 * its facts come from the manifest (`meta.tenant`) of the chosen bundle — or
 * the newest completed one — read from the off-site target, the same place a
 * re-create reads them from. If that read fails the bundles are still listed,
 * and `infoError` says why the facts are missing.
 */
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import type { DrRecoveryBundle, DrRecoveryInfo } from '@insula/api-contracts';
import { hostingPlans, tenants } from '../../db/schema.js';

interface BundleRow {
  readonly id: string;
  readonly created_at: Date | string;
  readonly finished_at: Date | string | null;
  readonly status: string;
  readonly initiator: string;
  readonly system_trigger: string | null;
  readonly label: string | null;
  readonly expires_at: Date | string | null;
  readonly components: Array<{ component: string; sizeBytes: number | string }> | null;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** A bundle row as the screen lists it. Pure. */
export function toRecoveryBundle(r: BundleRow): DrRecoveryBundle {
  const components = (r.components ?? []).map((c) => ({ component: c.component, sizeBytes: Number(c.sizeBytes) || 0 }));
  return {
    id: r.id,
    createdAt: iso(r.created_at)!,
    finishedAt: iso(r.finished_at),
    status: r.status,
    trigger: r.initiator === 'system' ? (r.system_trigger ?? 'system') : r.initiator,
    label: r.label,
    sizeBytes: components.reduce((n, c) => n + c.sizeBytes, 0),
    components,
    expiresAt: iso(r.expires_at),
  };
}

/** The tenant's restorable bundles (completed or partial, not expired), newest first. */
async function listBundles(app: FastifyInstance, tenantId: string): Promise<DrRecoveryBundle[]> {
  const res = await app.db.execute(sql`
    SELECT b.id, b.created_at, b.finished_at, b.status, b.initiator, b.system_trigger, b.label, b.expires_at,
           (SELECT json_agg(json_build_object('component', c.component, 'sizeBytes', c.total) ORDER BY c.component)
              FROM (SELECT component, sum(size_bytes) AS total FROM backup_components
                     WHERE backup_job_id = b.id GROUP BY component) c) AS components
      FROM backup_jobs b
     WHERE b.tenant_id = ${tenantId}
       AND b.status IN ('completed', 'partial')
       AND (b.expires_at IS NULL OR b.expires_at > now())
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT 200
  `) as unknown as { rows?: BundleRow[] };
  return (res.rows ?? []).map(toRecoveryBundle);
}

async function namespaceExists(app: FastifyInstance, namespace: string | null): Promise<boolean | null> {
  if (!namespace) return null;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
    await createK8sClients(kubeconfigPath).core.readNamespace({ name: namespace });
    return true;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    return code === 404 ? false : null;
  }
}

async function planName(app: FastifyInstance, planId: string | null): Promise<string | null> {
  if (!planId) return null;
  const [p] = await app.db.select({ name: hostingPlans.name }).from(hostingPlans).where(eq(hostingPlans.id, planId)).limit(1);
  return p?.name ?? null;
}

export async function getRecoveryInfo(
  app: FastifyInstance,
  tenantId: string,
  opts: { bundleId?: string } = {},
): Promise<DrRecoveryInfo> {
  const bundles = await listBundles(app, tenantId);
  const [live] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

  if (live) {
    return {
      tenantId,
      name: live.name,
      deleted: false,
      deletedAt: null,
      source: 'live',
      infoFromBundleId: null,
      infoError: null,
      status: live.status,
      planName: await planName(app, live.planId),
      storageTier: live.storageTier ?? null,
      primaryNode: live.nodeName ?? null,
      namespace: live.kubernetesNamespace,
      namespacePresent: await namespaceExists(app, live.kubernetesNamespace),
      resources: null,
      bundles,
    };
  }

  // Deleted: name it as the lists do, then read the rest from a manifest.
  const { listRecoverableTenants } = await import('../tenant-bundles/recoverable.js');
  const listed = (await listRecoverableTenants(app.db)).find((t) => t.tenantId === tenantId);
  const fromBundle = opts.bundleId
    ?? bundles.find((b) => b.status === 'completed')?.id
    ?? null;
  const base: DrRecoveryInfo = {
    tenantId,
    name: listed?.name ?? `tenant ${tenantId.slice(0, 8)}`,
    deleted: true,
    deletedAt: listed?.deletedAt ?? null,
    source: 'none',
    infoFromBundleId: fromBundle,
    infoError: fromBundle ? null : 'No completed bundle to read the tenant from.',
    status: null,
    planName: null,
    storageTier: null,
    primaryNode: null,
    namespace: null,
    namespacePresent: null,
    resources: null,
    bundles,
  };
  if (!fromBundle) return base;
  try {
    const { resolveTenantClassBundleStore } = await import('./recreate.js');
    const { store } = await resolveTenantClassBundleStore(app);
    const handle = await store.open(fromBundle);
    const meta = handle ? await store.getMeta(handle) : null;
    const t = meta?.tenant ?? null;
    if (!t) return { ...base, infoError: 'The bundle carries no tenant record (a legacy capture).' };
    // A tenant deleted before its name was recorded on the delete is listed by
    // its namespace slug. Its manifest knows the real name: keep it, so every
    // list shows it from now on. A display name only — a failure changes nothing.
    await app.db.execute(sql`
      UPDATE tenant_lifecycle_transitions
         SET detail = coalesce(detail, '{}'::jsonb) || jsonb_build_object('tenantName', ${t.name}::text)
       WHERE tenant_id = ${tenantId} AND transition_kind = 'deleted' AND detail->>'tenantName' IS NULL
    `).catch(() => undefined);
    return {
      ...base,
      name: t.name,
      source: 'bundle',
      infoError: null,
      status: t.status,
      planName: await planName(app, t.planId),
      storageTier: t.storageTier,
      primaryNode: t.nodeName,
      namespace: t.kubernetesNamespace,
      namespacePresent: await namespaceExists(app, t.kubernetesNamespace),
      resources: t.effectiveResources
        ? { cpuLimit: t.effectiveResources.cpuLimit, memoryLimit: t.effectiveResources.memoryLimit, storageLimit: t.effectiveResources.storageLimit }
        : null,
    };
  } catch (err) {
    return { ...base, infoError: `Could not read the bundle: ${err instanceof Error ? err.message : String(err)}` };
  }
}
