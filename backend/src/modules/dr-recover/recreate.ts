/**
 * DR "deleted-client re-create" (S4 cross-cluster / cheap-multi-region unlock).
 *
 * When {@link ../routes.ts drRecoverRoutes} finds NO local `tenants` row for the
 * target id, this module re-creates the tenant purely from the off-site
 * bundle's `meta.tenant` block, PRESERVING the original tenantId + namespace,
 * and registers a local `backup_jobs` / `backup_components` index so the
 * EXISTING provision + restore-cart flow can then run unchanged.
 *
 * Why re-create is even possible without a local row:
 *   - A hard-deleted tenant cascade-drops its `backup_jobs` row (FK
 *     `onDelete: cascade`), so the only handle left is the operator-supplied
 *     bundleId + the cluster's assigned tenant-class backup target.
 *   - `BackupStore.open(bundleId)` + `getMeta()` resolve a bundle WITHOUT any
 *     local tenant/backup_jobs row — the bundle prefix is keyed on bundleId.
 *   - meta.json v2 carries a `tenant` account block (name, plan, region, node,
 *     namespace, overrides…), which is enough to reconstruct the row.
 *
 * The original id MUST be preserved: the per-tenant restic repo password is
 * `HKDF(key, "restic-tenant-<id>")` and every bundle path + config-component FK
 * is keyed on it. The original namespace MUST be preserved too: the `config`
 * component restores the captured `tenants` row (incl. `kubernetes_namespace`)
 * over the row created here, and the files/mailbox executors resolve the
 * namespace fresh from that row — a freshly-generated namespace would
 * permanently drift from the provisioned one.
 *
 * This is the un-deferred half of `POST /admin/tenant-bundles/import-finalize`'s
 * "reuseUuid / reuseNamespace" TODO.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import {
  tenants,
  regions,
  hostingPlans,
  backupJobs,
  backupComponents,
  backupConfigurations,
  backupTargetAssignments,
} from '../../db/schema.js';
import type { BackupComponentName, BackupMetaV2, CreateTenantInput } from '@insula/api-contracts';
import type { BackupStore } from '../tenant-bundles/bundle-store.js';

/**
 * Residual manual steps the recover route CANNOT close on its own after a
 * re-create+restore. Data + config rows are restored, but these need operator
 * follow-up. Returned in the response (and logged) so the harness/operator
 * knows what is left. We deliberately do NOT attempt workload re-deploy here —
 * that is a separate gap.
 */
export const DR_RECREATE_RESIDUAL_GAPS: readonly string[] = [
  'Workloads are NOT auto-redeployed: restored `deployments` rows exist but no pods are scheduled. Re-provision each workload (deployment reconciler) or redeploy it from the catalog.',
  'Mail principals may be out of sync: restored `mailboxes` rows exist but the Stalwart directory may not yet hold the principals. If mail login fails, run the mailbox principal sync (ensure-stalwart-principals).',
  'Cross-cluster DNS/ingress: verify `ingress_routes` resolve on this cluster — the CNAME chain + ingress IP differ per region, so client DNS may need updating.',
];

/** Representative artifact name per component for the reconstructed index. */
const ARTIFACT_NAME: Readonly<Record<BackupComponentName, string>> = {
  config: 'db-rows.json.gz',
  files: 'archive.tar.gz',
  mailboxes: 'mailboxes',
  secrets: 'tls.json.gz.enc',
};

export interface ResolvedBundleStore {
  readonly store: BackupStore;
  readonly targetConfigId: string;
}

export interface RecreateResult {
  /** Fresh copy of {@link DR_RECREATE_RESIDUAL_GAPS} (immutable to callers). */
  readonly residualGaps: string[];
}

export interface RecreateOptions {
  /** Operator node choice (gap G2). Applied as the re-created tenant's pin. */
  readonly targetNode?: string;
  /**
   * Test seam: inject a pre-resolved store so unit tests need no k8s/config.
   * Production callers omit it and get {@link resolveTenantClassBundleStore}.
   */
  readonly resolveStore?: (app: FastifyInstance) => Promise<ResolvedBundleStore>;
}

/**
 * Resolve the cluster's `tenant`-class off-site store WITHOUT a local
 * backup_jobs row. Mirrors the run-now path in
 * `backup-restore/tenant-routes.ts`: prefer the assigned tenant-class target,
 * fall back to the legacy `active=true` config, then build a shim-first store
 * (handles every upstream protocol) with a direct cfg-based S3/SSH fallback.
 */
export async function resolveTenantClassBundleStore(app: FastifyInstance): Promise<ResolvedBundleStore> {
  const [assigned] = await app.db.select({ targetId: backupTargetAssignments.targetId })
    .from(backupTargetAssignments)
    .where(eq(backupTargetAssignments.backupClass, 'tenant'))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);

  let cfg: typeof backupConfigurations.$inferSelect | undefined;
  if (assigned) {
    const [row] = await app.db.select().from(backupConfigurations)
      .where(eq(backupConfigurations.id, assigned.targetId)).limit(1);
    cfg = row;
  }
  if (!cfg) {
    const [row] = await app.db.select().from(backupConfigurations)
      .where(eq(backupConfigurations.active, true)).limit(1);
    cfg = row;
  }
  if (!cfg) {
    throw new ApiError(
      'NO_BACKUP_TARGET',
      'No backup target assigned to the tenant class; cannot open the off-site bundle to re-create the deleted tenant.',
      409,
      undefined,
      'Assign a tenant-class backup target (Backups → Targets) pointing at the source cluster off-site storage, then retry.',
    );
  }

  let store: BackupStore;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
    const { resolveShimBackupStore } = await import('../tenant-bundles/shim-backup-store.js');
    const k8sClients = createK8sClients(kubeconfigPath);
    store = await resolveShimBackupStore(k8sClients.core, 'tenant', { log: app.log });
  } catch (err) {
    app.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'dr-recover re-create: shim store unavailable — falling back to direct cfg store',
    );
    const { resolveDirectStoreForBundle } = await import('../backup-restore/shared.js');
    store = await resolveDirectStoreForBundle(app, cfg.id);
  }
  return { store, targetConfigId: cfg.id };
}

/**
 * Re-create a deleted tenant from an off-site bundle, then register a local
 * bundle index so the caller can fall through to the existing provision +
 * restore-cart flow. Throws an `ApiError` (never a raw FK error) on every
 * validation failure. On success the `tenants` row exists with the original
 * id + namespace and a `completed` `backup_jobs` row points at `bundleId`.
 */
export async function recreateTenantFromBundle(
  app: FastifyInstance,
  tenantId: string,
  bundleId: string,
  opts: RecreateOptions = {},
): Promise<RecreateResult> {
  // ── 1. Resolve the off-site store, open the bundle, read its manifest ──
  const { store, targetConfigId } = await (opts.resolveStore ?? resolveTenantClassBundleStore)(app);
  const handle = await store.open(bundleId);
  let meta: BackupMetaV2 | null = null;
  if (handle) {
    try {
      meta = await store.getMeta(handle);
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err), bundleId },
        'dr-recover re-create: getMeta failed (bundle missing or unreadable)',
      );
    }
  }
  if (!handle || !meta) {
    throw new ApiError(
      'DR_BUNDLE_NOT_FOUND',
      `Bundle '${bundleId}' not found on the tenant-class off-site target`,
      404,
      { bundle_id: bundleId },
      "Confirm the bundleId and that this cluster's tenant-class backup target points at the source cluster's off-site storage.",
    );
  }

  // ── 2. Validate the manifest describes THIS tenant + carries a v2 block ──
  if (meta.tenantId !== tenantId) {
    throw new ApiError(
      'DR_BUNDLE_TENANT_MISMATCH',
      `Bundle '${bundleId}' belongs to tenant '${meta.tenantId}', not '${tenantId}'`,
      400,
      { bundle_id: bundleId, bundle_tenant_id: meta.tenantId, tenant_id: tenantId },
    );
  }
  const t = meta.tenant;
  if (!t) {
    throw new ApiError(
      'DR_CANNOT_RECREATE_LEGACY_BUNDLE',
      `Bundle '${bundleId}' has no tenant metadata block (legacy v1 capture); cannot re-create a deleted tenant from it`,
      400,
      { bundle_id: bundleId },
      'Re-create requires a v2 bundle whose meta.json carries the tenant account block. Restore into an existing tenant instead.',
    );
  }

  // ── 3. Plan + region UUIDs are captured on the SOURCE cluster; they MUST
  //       exist here or the tenants INSERT hits an FK violation. Fail loudly
  //       with remediation rather than letting Postgres leak a raw constraint
  //       error — the hardest cross-cluster footgun. ─────────────────────────
  const [planRow] = await app.db.select({ id: hostingPlans.id })
    .from(hostingPlans).where(eq(hostingPlans.id, t.planId)).limit(1);
  const [regionRow] = await app.db.select({ id: regions.id })
    .from(regions).where(eq(regions.id, t.regionId)).limit(1);
  if (!planRow || !regionRow) {
    throw new ApiError(
      'DR_PLAN_REGION_MISSING',
      `The bundle's plan (${t.planId})${planRow ? '' : ' [MISSING]'} and region (${t.regionId})${regionRow ? '' : ' [MISSING]'} must both exist on this cluster before re-create`,
      400,
      { plan_id: t.planId, plan_present: !!planRow, region_id: t.regionId, region_present: !!regionRow },
      "The bundle's plan/region UUIDs must exist on the target cluster; create a matching plan/region (same UUID) or correct the bundle, then retry.",
    );
  }

  // ── 4. Re-create the tenant row, PRESERVING the original id + namespace ──
  const createInput: CreateTenantInput = {
    name: t.name,
    primary_email: t.primaryEmail,
    secondary_email: t.secondaryEmail ?? undefined,
    plan_id: t.planId,
    region_id: t.regionId,
    // Placement: honour the operator's targetNode (a real node on THIS
    // cluster). We deliberately do NOT reuse meta.tenant.nodeName — a node
    // captured on the source cluster likely does not exist here and would
    // trip createTenant's worker-pin validation. Omit → scheduler auto-picks.
    node_name: opts.targetNode ?? undefined,
    // meta.tenant.storageTier is a free-form string ('local' | 'longhorn' | …);
    // the create contract only accepts 'local' | 'ha'. Coerce conservatively.
    storage_tier: t.storageTier === 'ha' ? 'ha' : 'local',
    timezone: t.timezone ?? undefined,
    subscription_expires_at: t.subscriptionExpiresAt ?? undefined,
  };
  const { createTenant } = await import('../tenants/service.js');
  await createTenant(app.db, createInput, 'system', {
    tenantIdOverride: tenantId,
    namespaceOverride: t.kubernetesNamespace,
  });

  // ── 5. Register a local backup_jobs + backup_components index for the
  //       bundle so the EXISTING recover flow (§2 bundle lookup, §3 component
  //       detection, and every restore-cart executor's resolveStoreForBundle)
  //       finds it — the source cluster's job row was cascade-dropped with the
  //       tenant. Mirrors POST /admin/tenant-bundles/import-finalize. ─────────
  const now = new Date();
  await app.db.insert(backupJobs).values({
    id: bundleId,
    tenantId,
    initiator: 'admin',
    systemTrigger: null,
    status: 'completed',
    targetKind: store.kind,
    targetUri: `${store.kind}://${targetConfigId}`,
    targetConfigId,
    label: meta.label,
    description: meta.description,
    sizeBytes: 0,
    retentionDays: meta.retentionDays,
    expiresAt: null,
    startedAt: now,
    finishedAt: now,
  });

  const componentRows: Array<typeof backupComponents.$inferInsert> = [];
  for (const name of ['config', 'files', 'mailboxes', 'secrets'] as const) {
    const c = meta.components[name];
    if (!c) continue;
    componentRows.push({
      id: crypto.randomUUID(),
      backupJobId: bundleId,
      component: name,
      artifactName: ARTIFACT_NAME[name],
      status: 'completed',
      sizeBytes: typeof c.sizeBytes === 'number' ? c.sizeBytes : 0,
      sha256: 'sha256' in c && typeof c.sha256 === 'string' ? c.sha256 : null,
      startedAt: now,
      finishedAt: now,
    });
  }
  if (componentRows.length > 0) {
    await app.db.insert(backupComponents).values(componentRows);
  }

  app.log.warn(
    { tenantId, bundleId, targetConfigId, namespace: t.kubernetesNamespace },
    'dr-recover: re-created deleted tenant from bundle (original id + namespace preserved)',
  );

  return { residualGaps: [...DR_RECREATE_RESIDUAL_GAPS] };
}
